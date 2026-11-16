import { bracketProfitInMoney } from "../../core/trading-settings.js";
import { protectionFields } from "../../core/parent-protection.js";
import { OrderType } from "../../contracts/broker.js";
import type { PreOrder } from "../../contracts/broker.js";
import type {
  TradingChartBinding,
  TradingCollectionPort,
  TradingOverlayHandle,
  TradingOverlayEvent,
  TradingOverlaySpec,
  TradingProtectionLeg,
} from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import type { TicketController } from "./controller.js";
import { orderEntryPrice, executablePrice } from "../../core/financial-rules.js";
import { effectiveTick, snapToStep } from "../../core/trading-rules.js";
import { exitProfitText } from "../../chart/exit-profit.js";
import { sameBinding } from "../../core/identity.js";
import { contextOrderType } from "../../core/context-orders.js";
import { DisposalScope } from "../../core/disposal.js";
import { equalData } from "../../core/immutable.js";
import type { EntityChange } from "../../core/entity-store.js";
import { ticketEditable } from "./rules.js";
import { projectTicketOverlays, type TicketLineTarget } from "../../chart/ticket-projection.js";
import { normalizeOverlayEvent } from "../../chart/overlay-events.js";

type Controller = TicketController;
/** The ticket is the canonical unsent order; chart lines are transient views, never broker rows. */
export function createTicketProjection(
  session: TradingSession,
  collection: TradingCollectionPort,
  ticket: Controller,
  focusQuantity: () => void = () => {},
) {
  const scope = new DisposalScope();
  let handle: TradingOverlayHandle | undefined, release: (() => void) | undefined;
  let binding: TradingChartBinding | undefined, previous: TradingOverlaySpec | undefined;
  let gesture:
    | {
        id: string;
        source: TradingOverlayHandle;
        leg?: TradingProtectionLeg;
        revision: number;
        order: ReturnType<Controller["state"]["get"]>["order"];
      }
    | undefined;
  const legs = new Map<
    string,
    {
      handle: TradingOverlayHandle;
      release: () => void;
      spec: TradingOverlaySpec;
    }
  >();
  let finance: { symbol: string; release?: () => void } | undefined;
  function releaseFinance() {
    const previous = finance;
    finance = undefined;
    previous?.release?.();
  }
  const currencies = new Map<string, string>();
  function updateCurrencies() {
    currencies.clear();
    for (const account of session.accounts?.get() ?? [])
      if (account.currency) currencies.set(account.id, account.currency);
  }
  updateCurrencies();
  let applying = false;
  function restoreDraft(original: Readonly<PreOrder>) {
    // Explicit undefined clears fields introduced by the gesture.
    ticket.patch({
      ...original,
      ...protectionFields(original),
      limitPrice: original.limitPrice,
      stopPrice: original.stopPrice,
    });
  }
  function cancelGesture(restore = false) {
    const previous = gesture;
    gesture = undefined;
    const current = ticket.state.get();
    if (restore && previous && current.revision === previous.revision && ticketEditable(current.phase)) {
      const wasApplying = applying;
      applying = true;
      try { restoreDraft(previous.order); }
      finally { applying = wasApplying; }
    }
    previous?.source.cancelInteraction();
  }
  function subscribe(source: TradingOverlayHandle, target?: TicketLineTarget) {
    let active = true;
    const release = source.subscribe(input => {
      if (!active) return;
      let value: TradingOverlayEvent;
      try { value = normalizeOverlayEvent(input); }
      catch { cancelGesture(true); return; }
      if (target) lineEvent(value, target, source);
      else event(value, undefined, source);
    });
    return () => { active = false; release(); };
  }
  function remove() {
    releaseFinance();
    for (const value of legs.values()) {
      value.release();
      value.handle.remove();
    }
    legs.clear();
    const old = handle;
    handle = undefined;
    release?.();
    release = undefined;
    previous = undefined;
    gesture = undefined;
    old?.remove();
  }
  function event(event: TradingOverlayEvent, target?: TicketLineTarget, source = handle) {
    const current = ticket.state.get();
    if (!ticketEditable(current.phase)) return;
    if (event.type === "submit") {
      if (!target && !gesture) void ticket.review();
      return;
    }
    if (event.type === "cancel") {
      ticket.close();
      return;
    }
    if (event.type === "modify") {
      focusQuantity();
      return;
    }
    if (event.type === "dragStart") {
      if (!source) return;
      gesture = {
        id: event.gestureId,
        source,
        leg: target ? undefined : event.leg,
        revision: current.revision,
        order: current.order,
      };
      return;
    }
    if (event.type !== "dragPreview" && event.type !== "dragCancel" && event.type !== "dragCommit") return;
    if (!gesture || gesture.id !== event.gestureId) return;
    if (current.revision !== gesture.revision) {
      cancelGesture();
      return;
    }
    applying = true;
    try {
      if (event.type === "dragCancel") {
        const original = gesture.order;
        gesture = undefined;
        restoreDraft(original);
        return;
      }
      if (event.type === "dragCommit") {
        gesture = undefined;
        if (!event.leg || !current.instrument) return;
      }
      if (target?.trigger) ticket.patch({ stopPrice: event.price });
      else if (event.leg) {
        // The chart can display finer prices than the broker accepts. Snap when the drag ends.
        const price = event.type === "dragCommit" && current.instrument
          ? snapToStep(event.price, effectiveTick(event.price, current.instrument))
          : event.price;
        const leg = event.leg;
        if (target?.level) {
          ticket.patchProtection({
            exitLevels: current.order.exitLevels?.map((level) =>
              level.id === target.level ? { ...level, [leg]: price } : level,
            ),
          });
        } else ticket.patchProtection({ [leg]: price });
      } else {
        const quote = session.state.quotes.get(current.order.symbol);
        const market = executablePrice(current.order.side, quote);
        const type =
          current.order.type === OrderType.Market && market !== undefined
            ? contextOrderType(current.order.side, event.price, market)
            : current.order.type;
        if (!session.symbolPolicy(current.order.symbol).orderTypes.includes(type!)) {
          cancelGesture(true);
          return;
        }
        ticket.patch({
          type,
          ...(type === OrderType.Stop ? { stopPrice: event.price } : { limitPrice: event.price }),
        });
      }
      if (gesture) gesture.revision = ticket.state.get().revision;
    } finally {
      applying = false;
      sync();
    }
  }
  /** Events from a projected exit line: remove the leg, focus the ticket, or drag it. */
  function lineEvent(value: TradingOverlayEvent, target: TicketLineTarget, source: TradingOverlayHandle) {
    const leg = target.leg;
    if (value.type === "cancel") {
      if (!ticketEditable(ticket.state.get().phase) || target.trigger) return;
      const order = ticket.state.get().order;
      if (target.level) {
        const unpaired = session.symbolPolicy(order.symbol).flags.supportUnpairedExitLevels;
        ticket.patchProtection({
          exitLevels: order.exitLevels?.flatMap((level) => {
            if (level.id !== target.level) return [level];
            if (!unpaired) return [];
            return [{ ...level, [leg!]: undefined }];
          }),
        });
      } else if (leg) ticket.patchProtection({ [leg]: undefined });
      return;
    }
    if (value.type === "modify") {
      focusQuantity();
      return;
    }
    if ("gestureId" in value) event({ ...value, leg }, target, source);
  }
  let synchronizing = false;
  function sync() {
    if (synchronizing) return;
    synchronizing = true;
    try {
      synchronize();
    } finally {
      synchronizing = false;
    }
  }
  function synchronize() {
    const state = ticket.state.get();
    if (gesture && !applying && (state.revision !== gesture.revision || !ticketEditable(state.phase)))
      cancelGesture();
    const allowed = ["editing", "error", "confirming", "previewing", "sending"].includes(state.phase);
    if (!allowed || "id" in state.order) {
      remove();
      return;
    }
    const chart = collection
      .charts()
      .find(
        (chart) =>
          state.binding &&
          sameBinding(chart.binding.get(), state.binding) &&
          chart.binding.get().symbol === state.order.symbol,
      );
    if (!chart) {
      remove();
      return;
    }
    const quote = session.state.quotes.get(state.order.symbol);
    const price = orderEntryPrice(state.order, quote) ?? executablePrice(state.order.side, quote);
    if (price === undefined || !Number.isFinite(price) || !Number.isFinite(state.order.qty) || state.order.qty <= 0) {
      remove();
      return;
    }
    const symbolPolicy = session.symbolPolicy(state.order.symbol);
    const flags = symbolPolicy.flags;
    const editable = ticketEditable(state.phase);
    const display = session.displaySettings.get();
    const projection = projectTicketOverlays({
      order: state.order,
      entry: price,
      editable,
      pending: !editable,
      activeLeg: gesture?.leg,
      flags,
      profitText: (exit, qty) =>
        exitProfitText({
          instrument: state.instrument,
          side: state.order.side,
          qty,
          entry: price,
          exit,
          display,
          pipValues: session.state.pipValues.get(state.order.symbol),
          inInstrumentCurrency: flags.positionPLInInstrumentCurrency,
          accountCurrency: currencies.get(state.context?.accountId ?? ""),
        }),
    });
    const spec = projection.entry;
    if (handle && (!binding || !sameBinding(binding, chart.binding.get()) || previous?.side !== spec.side)) remove();
    if (!handle) {
      binding = chart.binding.get();
      handle = chart.createOverlay(spec);
      release = subscribe(handle);
    } else if (!equalData(previous, spec)) handle.update(spec);
    previous = spec;
    // Money previews during a gesture need live pip values unless P&L stays in instrument currency.
    const hasExit =
      state.order.takeProfit !== undefined || state.order.stopLoss !== undefined || !!state.order.exitLevels?.length;
    const needsPipFinance =
      symbolPolicy.pipValues !== false &&
      !!gesture &&
      editable &&
      !flags.positionPLInInstrumentCurrency &&
      hasExit &&
      bracketProfitInMoney(display);
    if (needsPipFinance && finance?.symbol !== state.order.symbol) {
      releaseFinance();
      finance = { symbol: state.order.symbol };
      try {
        finance.release = session.acquireFinancial("pip", state.order.symbol);
      } catch {
        /* Keep price controls available without a financial provider. */
      }
    } else if (!needsPipFinance && finance) releaseFinance();
    const keys = new Set(projection.lines.map((line) => line.key));
    for (const [key, value] of legs)
      if (!keys.has(key)) {
        value.release();
        value.handle.remove();
        legs.delete(key);
      }
    for (const line of projection.lines) {
      const current = legs.get(line.key);
      if (!current) {
        const overlay = chart.createOverlay(line.spec);
        const target = line.target;
        const release = subscribe(overlay, target);
        legs.set(line.key, { handle: overlay, release, spec: line.spec });
      } else if (!equalData(current.spec, line.spec)) {
        current.handle.update(line.spec);
        current.spec = line.spec;
      }
    }
  }
  scope.own(ticket.state.subscribe(sync));
  function financialChange(change: EntityChange) {
    const symbol = ticket.state.get().order.symbol;
    if (change.added.includes(symbol) || change.updated.includes(symbol) || change.removed.includes(symbol)) sync();
  }
  scope.own(session.state.quotes.subscribeChanges(financialChange));
  scope.own(collection.subscribe(sync));
  scope.own(remove);
  scope.own(session.policy.subscribe(sync));
  if (session.accounts)
    scope.own(
      session.accounts.subscribe(() => {
        updateCurrencies();
        sync();
      }),
    );
  scope.own(session.displaySettings.subscribe(sync));
  scope.own(session.state.pipValues.subscribeChanges(financialChange));
  sync();
  return { destroy: () => scope.destroy() };
}
