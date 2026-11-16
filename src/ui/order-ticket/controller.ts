import { userMessage } from "../../core/errors.js";
import { ticketEditable } from "./rules.js";
import { ticketShowsPreview, ticketSkipsReview } from "../../core/review-policy.js";
import {
  defaultDuration,
  durationOptions,
  withDefaultDuration,
} from "../../core/order-duration.js";
import { OrderType, Side, StopType } from "../../contracts/broker.js";
import type {
  TradingDialogCustomField,
  ExitLevelTemplate,
  InstrumentInfo,
  Order,
  OrderDialogOptions,
  OrderPreviewResult,
  PreOrder,
} from "../../contracts/broker.js";
import type { TradingChartBinding } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import type { TradingCommandContext } from "../../core/trading-commands.js";
import { ValueStore } from "../../core/value-store.js";
import { valueReader } from "../../core/readers.js";
import { validateQuantity } from "../../core/trading-rules.js";
import { TradingError } from "../../core/errors.js";
import { resolveExitLevelTemplates } from "../../core/exit-level-template.js";
import { executablePrice, orderEntryPrice } from "../../core/financial-rules.js";
import { followCommand, watchAcceptance } from "../../core/command-follow.js";
import { commandKeys } from "../../core/command-keys.js";
export interface TicketState {
  readonly binding?: TradingChartBinding;
  readonly context?: TradingCommandContext;
  readonly order: PreOrder | Order;
  readonly revision: number;
  readonly phase:
    | "closed"
    | "loading"
    | "editing"
    | "previewing"
    | "confirming"
    | "sending"
    | "confirmed"
    | "unconfirmed"
    | "error";
  readonly refreshing?: boolean;
  /** While sending: the broker acknowledged the request but has not confirmed its result yet. */
  readonly accepted?: boolean;
  /** While unconfirmed: true as long as the session is still checking with the broker; false once unresolved. */
  readonly checking?: boolean;
  readonly instrument?: InstrumentInfo;
  readonly options?: OrderDialogOptions;
  readonly preview?: OrderPreviewResult;
  readonly previewToken?: string;
  readonly error?: string;
}
/** How a ticket phase continues an on-chart proposal; a closed or settled ticket ends it. */
function chartEditPhase(phase: TicketState["phase"]): "reviewing" | "sending" | undefined {
  if (phase === "closed" || phase === "confirmed" || phase === "unconfirmed") return undefined;
  return phase === "sending" ? "sending" : "reviewing";
}
/** Form state is independent of mounting/docking. Every edit invalidates the exact preview identity. */
export function createTicketController(session: TradingSession) {
  const state = new ValueStore<TicketState>({
    order: { symbol: "", type: OrderType.Market, side: Side.Buy, qty: 1 },
    phase: "closed",
    revision: 0,
  });
  const releaseChartEdit = state.subscribe(value => session.chartEdits.sync(value.order, chartEditPhase(value.phase)));
  let disposed = false,
    sequence = 0;
  let metadata: OrderDialogOptions | undefined;
  let rememberedStopLoss: number | undefined;
  const manualQuantityListeners = new Set<() => void>();
  let releaseFollow: (() => void) | undefined;
  function stopFollowing(): void {
    releaseFollow?.();
    releaseFollow = undefined;
  }
  /**
   * Follows an unconfirmed command's pending record so a late broker match or rejection reaches this ticket. Fenced by
   * the send request: any newer ticket action, close, account change or teardown stops it.
   */
  function follow(request: number, commandId: string): void {
    stopFollowing();
    releaseFollow = followCommand(session.pending, commandId, outcome => {
      const current = state.get();
      if (disposed || request !== sequence || current.phase !== "unconfirmed") {
        stopFollowing();
        return;
      }
      if (outcome.kind === "confirmed" || outcome.kind === "changed") {
        state.set({
          ...current,
          phase: "confirmed",
          checking: undefined,
          error: outcome.kind === "changed" ? "The order changed at the broker. Review its latest details." : undefined,
        });
        return;
      }
      if (outcome.kind === "rejected") {
        state.set({
          ...current,
          phase: "error",
          checking: undefined,
          preview: undefined,
          previewToken: undefined,
          error: outcome.error ?? "The broker could not complete the operation.",
        });
        return;
      }
      const checking = outcome.kind === "checking";
      if (current.checking !== checking) state.set({ ...current, checking });
    });
  }
  const unsubscribe = session.state.connection.subscribe((value) => {
    if (value.phase === "switching" || value.phase === "disposed") close();
  });
  function close(): void {
    rememberedStopLoss = undefined;
    stopFollowing();
    sequence++;
    state.set({
      ...state.get(),
      phase: "closed",
      preview: undefined,
      previewToken: undefined,
      context: undefined,
      refreshing: false,
    });
  }
  const customKey = (id: string) => `customField:${id}`;
  /** Masked fields are never persisted, even when the broker asks for saveToSettings. */
  const persistable = (field: TradingDialogCustomField) =>
    field.saveToSettings === true &&
    !("maskWithAsterisk" in field && field.maskWithAsterisk === true);
  function savedCustomValue(field: TradingDialogCustomField): unknown {
    if (!persistable(field)) return undefined;
    try {
      const saved = session.preferences.get(customKey(field.id));
      return saved === undefined ? undefined : JSON.parse(saved);
    } catch {
      return undefined;
    }
  }
  function saveCustomValues(values: Record<string, unknown>): void {
    for (const field of metadata?.customFields ?? []) {
      if (!persistable(field) || !(field.id in values)) continue;
      try {
        session.preferences.set(
          customKey(field.id),
          JSON.stringify(values[field.id]),
        );
      } catch {
        /* The current draft keeps the value when storage is unavailable. */
      }
    }
  }
  /** Templates may express exits as pips, percentages or money; resolve them against the current entry. */
  function resolveTemplateLevels(
    order: Readonly<PreOrder>,
    levels: readonly ExitLevelTemplate[],
    instrument: InstrumentInfo,
  ) {
    const quote = session.state.quotes.get(order.symbol);
    const pip = session.state.pipValues.get(order.symbol);
    const account = session.accounts
      .get()
      .find((value) => value.id === session.state.connection.get().accountId);
    return resolveExitLevelTemplates(levels, {
      entry: orderEntryPrice(order, quote),
      side: order.side,
      instrument,
      equity: session.state.equity.get(),
      pipValue:
        order.side === Side.Buy ? pip?.buyPipValue : pip?.sellPipValue,
      accountCurrency: account?.currency,
    });
  }
  async function open(
    binding: TradingChartBinding,
    template?: Partial<PreOrder> | Order,
  ): Promise<void> {
    if (disposed) throw TradingError.disposed("This ticket is closed.");
    const request = ++sequence;
    const modifying = template && "id" in template;
    const edit = session.chartEdits.state.get();
    const context = modifying && edit?.kind === "order" && edit.id === template.id
      ? edit.context
      : session.commands.context(modifying ? template.id : undefined);
    const order = {
      symbol: binding.symbol,
      type: OrderType.Market,
      side: Side.Buy,
      qty: 1,
      ...structuredClone(template),
    };
    rememberedStopLoss = undefined;
    state.set({ binding, context, order, phase: "loading", revision: request });
    try {
      const [instrument, options, quantity] = await Promise.all([
        session.symbolInfo(binding.symbol),
        session.orderDialogOptions(binding.symbol),
        session.host.getQty(binding.symbol),
      ]);
      if (disposed || request !== sequence) return;
      const current = state.get();
      metadata = options;
      const displayOptions = options
        ? {
            ...options,
            customFields: options.customFields?.map((field) => {
              const result = { ...field };
              if ("validator" in result) delete result.validator;
              return result;
            }),
          }
        : undefined;
      const templateLevels = !modifying ? template?.exitLevels : undefined;
      const exitLevels = templateLevels?.length
        ? resolveTemplateLevels(current.order, templateLevels, instrument)
        : undefined;
      const customFields = Object.fromEntries(
        (options?.customFields ?? []).map((field) => [
          field.id,
          savedCustomValue(field) ?? structuredClone(field.value),
        ]),
      );
      state.set({
        ...current,
        instrument,
        options: displayOptions,
        phase: "editing",
        order: modifying
          ? {
              ...current.order,
              qty: template?.qty ?? quantity,
              customFields: template?.customFields,
            }
          : withDefaultDuration(
              {
                ...current.order,
                ...(exitLevels ? { exitLevels } : {}),
                qty: template?.qty ?? quantity,
                customFields: template?.customFields ?? customFields,
              },
              session.symbolPolicy(order.symbol),
              instrument,
            ),
      });
    } catch (cause) {
      fail(request, cause, "Order information is unavailable.");
    }
  }
  /** Shows a failure for the current request only; later edits or a closed ticket ignore it. */
  function fail(request: number, cause: unknown, fallback: string, extra: Partial<TicketState> = {}): void {
    if (disposed || request !== sequence) return;
    state.set({ ...state.get(), ...extra, phase: "error", error: userMessage(cause, fallback) });
  }
  function patch(changes: Partial<PreOrder>, sizing = false): void {
    const current = state.get();
    if (
      disposed ||
      current.refreshing ||
      current.phase === "closed" ||
      current.phase === "loading" ||
      current.phase === "sending" ||
      current.phase === "unconfirmed" ||
      current.phase === "confirmed"
    )
      return;
    if (changes.side !== undefined && changes.side !== current.order.side)
      rememberedStopLoss = undefined;
    if (changes.qty !== undefined && !sizing) {
      // A manual edit or another sizing control replaces the previous cash intent.
      for (const listener of [...manualQuantityListeners]) listener();
    }
    if (changes.qty !== undefined && current.instrument) {
      try {
        validateQuantity(changes.qty, current.instrument.qty);
        // Quote-driven sizing must not write preferences on each market update.
        if (!sizing) session.host.setQty(current.order.symbol, changes.qty);
      } catch {
        /* Keep invalid input in the draft for review, without persisting it. */
      }
    }
    const order = {
      ...current.order,
      ...structuredClone(changes),
      symbol: current.order.symbol,
    };
    if (changes.type !== undefined && changes.type !== current.order.type) {
      const policy = session.symbolPolicy(order.symbol);
      const options = durationOptions(policy, changes.type, current.instrument);
      if (!options.some((option) => option.value === order.duration?.type))
        order.duration = defaultDuration(
          policy,
          changes.type,
          current.instrument,
        );
    }
    if (changes.customFields) saveCustomValues(changes.customFields);
    sequence++;
    state.set({
      ...current,
      order,
      preview: undefined,
      previewToken: undefined,
      error: undefined,
      phase: "editing",
      revision: current.revision + 1,
    });
  }
  function rememberStopLoss(next: number | undefined): void {
    const previous = state.get().order.stopLoss;
    if (previous !== undefined && Number.isFinite(previous)) rememberedStopLoss = previous;
    if (next !== undefined && Number.isFinite(next)) rememberedStopLoss = next;
  }
  /** Protection edits remember the latest finite stop so re-enabling stop loss restores it. */
  function patchProtection(changes: Partial<PreOrder>): void {
    const remembered = changes.stopLoss ?? state.get().order.stopLoss;
    if (Number.isFinite(remembered)) rememberedStopLoss = remembered;
    patch(changes);
  }
  /** Switching type keeps entered prices and fills missing ones from the current entry or quote. */
  function changeType(type: OrderType): void {
    const order = state.get().order;
    if (!session.symbolPolicy(order.symbol).orderTypes.includes(type)) return;
    const quote = session.state.quotes.get(order.symbol);
    const price = orderEntryPrice(order, quote) ?? executablePrice(order.side, quote);
    patch({ type, limitPrice: order.limitPrice ?? price, stopPrice: order.stopPrice ?? price });
  }
  function setStopLoss(stopLoss: number | undefined): void {
    rememberStopLoss(stopLoss);
    patch({ stopLoss, guaranteedStop: undefined, trailingStopPips: undefined, stopType: StopType.StopLoss });
  }
  function validateFields(order: PreOrder): void {
    for (const field of metadata?.customFields ?? []) {
      if (!("validator" in field) || !field.validator) continue;
      const raw = order.customFields?.[field.id];
      const value =
        field.inputType === "TextWithCheckBox" && raw && typeof raw === "object"
          ? raw.text
          : raw;
      const result = field.validator(value);
      if (!result.valid)
        throw new TradingError("invalid-input", result.errorMessage);
    }
  }
  const propsValidation = (context: TradingCommandContext, order: PreOrder) =>
    session.commands.validate({ context, order });
  async function review(): Promise<void> {
    const current = state.get();
    if (
      current.refreshing ||
      !current.context ||
      !ticketEditable(current.phase)
    )
      return;
    const request = ++sequence;
    // New orders carry the quotes seen at review (PreOrder.currentQuotes); preview and send share this draft.
    const quote = session.state.quotes.get(current.order.symbol);
    const order =
      "id" in current.order || quote?.ask === undefined || quote.bid === undefined
        ? current.order
        : { ...current.order, currentQuotes: { ask: quote.ask, bid: quote.bid } };
    state.set({ ...current, order, phase: "previewing", error: undefined });
    try {
      validateFields(order);
      await propsValidation(current.context, order);
      const modifying = "id" in order;
      const lease = ticketShowsPreview(session, order.symbol, modifying)
        ? await session.commands.preview({
            context: current.context,
            order: order,
          })
        : undefined;
      if (disposed || request !== sequence) return;
      state.set({
        ...state.get(),
        phase: "confirming",
        preview: lease?.preview ?? { sections: [] },
        previewToken: lease?.token,
      });
      // An explicit preference can skip review; forced confirmation always wins.
      // A preview already requested keeps its warnings/errors visible for review.
      if (!lease && ticketSkipsReview(session, order.symbol, modifying)) await send();
    } catch (cause) {
      fail(request, cause, "This order could not be reviewed.");
    }
  }
  async function send(): Promise<void> {
    const current = state.get();
    if (
      !current.context ||
      current.phase !== "confirming" ||
      current.preview?.errors?.length
    )
      return;
    const request = ++sequence;
    state.set({ ...current, phase: "sending", accepted: undefined, error: undefined });
    const key = "id" in current.order
      ? commandKeys.order(current.order.id)
      : commandKeys.place(current.context.accountId, current.order.symbol);
    const stopWatching = watchAcceptance(session.pending, key, session.clock.now(), () => {
      const latest = state.get();
      if (!disposed && request === sequence && latest.phase === "sending") state.set({ ...latest, accepted: true });
    });
    try {
      validateFields(current.order);
      const result =
        "id" in current.order
          ? await session.commands.modify({
              context: current.context,
              order: current.order,
              confirmId: current.preview?.confirmId,
              previewToken: current.previewToken,
            })
          : await session.commands.place({
              context: current.context,
              order: current.order,
              confirmId: current.preview?.confirmId,
              previewToken: current.previewToken,
            });
      if (disposed || request !== sequence) return;
      if (result.outcome === "unconfirmed") {
        state.set({ ...state.get(), phase: "unconfirmed", accepted: undefined, checking: true, error: undefined });
        follow(request, result.commandId);
        return;
      }
      state.set({
        ...state.get(),
        phase: "confirmed",
        accepted: undefined,
        checking: undefined,
        error:
          result.outcome === "changed"
            ? "The order changed at the broker. Review its latest details."
            : undefined,
      });
    } catch (cause) {
      fail(request, cause, "This order could not be sent.", { preview: undefined, previewToken: undefined, accepted: undefined });
    } finally {
      stopWatching();
    }
  }
  /**
   * After a confirmed new order, start the next draft as the reference terminal does: keep side, type, quantity,
   * duration and custom fields; reset the entry price to the current quote; clear all protection.
   */
  function startNext(): void {
    const current = state.get();
    if (disposed || current.phase !== "confirmed" || "id" in current.order)
      return;
    const quote = session.state.quotes.get(current.order.symbol);
    const entry =
      current.order.side === Side.Buy ? quote?.ask : quote?.bid;
    const pending = current.order.type !== OrderType.Market;
    sequence++;
    state.set({
      ...current,
      phase: "editing",
      preview: undefined,
      previewToken: undefined,
      error: undefined,
      revision: current.revision + 1,
      order: {
        ...current.order,
        limitPrice:
          pending && current.order.type !== OrderType.Stop ? entry : undefined,
        stopPrice:
          pending && current.order.type !== OrderType.Limit ? entry : undefined,
        takeProfit: undefined,
        stopLoss: undefined,
        guaranteedStop: undefined,
        trailingStopPips: undefined,
        stopType: undefined,
        exitLevels: undefined,
      },
    });
  }
  async function refreshInstrument(): Promise<void> {
    const current = state.get();
    if (
      disposed ||
      !current.context ||
      current.phase === "closed" ||
      current.phase === "sending"
    )
      return;
    const request = ++sequence;
    state.set({
      ...current,
      refreshing: true,
      phase: "editing",
      preview: undefined,
      previewToken: undefined,
      error: undefined,
      revision: current.revision + 1,
    });
    try {
      const instrument = await session.symbolInfo(current.order.symbol);
      if (!disposed && request === sequence)
        state.set({ ...state.get(), instrument, refreshing: false });
    } catch (cause) {
      fail(request, cause, "Trading information could not be refreshed.", { refreshing: false });
    }
  }
  return {
    refreshInstrument,
    rememberedStopLoss: () => rememberedStopLoss,
    patchProtection,
    setStopLoss,
    state: valueReader(state),
    open,
    patch: (changes: Partial<PreOrder>) => patch(changes),
    changeType,
    patchSizedQuantity: (qty: number) => patch({ qty }, true),
    onManualQuantityChange(listener: () => void): () => void {
      if (!disposed) manualQuantityListeners.add(listener);
      return () => {
        manualQuantityListeners.delete(listener);
      };
    },
    review,
    send,
    startNext,
    close,
    destroy() {
      if (disposed) return;
      close();
      disposed = true;
      releaseChartEdit();
      unsubscribe();
      manualQuantityListeners.clear();
      state.destroy();
    },
  };
}
export type TicketController = ReturnType<typeof createTicketController>;
