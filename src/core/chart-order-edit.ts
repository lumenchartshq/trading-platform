import { appendChartExit, moveChartExitLevel } from "./chart-exit-level.js";
import type {
  InstrumentInfo,
  Brackets,
  Order,
  Position,
  IndividualPosition,
  PreOrder,
} from "../contracts/broker.js";
import { OrderType } from "../contracts/broker.js";
import type { TradingChartBinding, TradingProtectionLeg } from "../contracts/ports.js";
import type { CommandEntityKind } from "./command-keys.js";
import type { TradingState } from "./trading-state.js";
import type { TradingCommandContext } from "./trading-commands.js";
import { assertLiveContext, assertRevision, entityStore } from "./command-context.js";
import { terminalStatuses } from "./entity-validation.js";
import { ValueStore } from "./value-store.js";
import { valueReader } from "./readers.js";
import { TradingError } from "./errors.js";
import { DisposalScope } from "./disposal.js";

export type ChartEditKind = CommandEntityKind;
export type ChartProtectionLeg = TradingProtectionLeg;
export interface ChartEditOptions {
  /** Protection leg being dragged; omitted for an order entry price move. */
  readonly leg?: ChartProtectionLeg;
  /** Append an allocated exit level instead of replacing the legacy pair. */
  readonly multiple?: boolean;
  /** Existing allocated level whose `leg` moves; set when a confirmed exit of that level is dragged. */
  readonly level?: string;
  /** Parent with broker child legs folded in, when protection lives in child orders. */
  readonly completed?: Readonly<Order | Position | IndividualPosition>;
}
export interface ChartOrderEdit {
  readonly token: number;
  readonly id: string;
  readonly kind: ChartEditKind;
  readonly binding: TradingChartBinding;
  readonly context: TradingCommandContext;
  readonly order: Readonly<Order | Position | IndividualPosition>;
  readonly phase: "dragging" | "reviewing" | "sending";
  readonly leg?: ChartProtectionLeg;
  readonly multiple?: boolean;
  readonly level?: string;
}
/** Exit level ID of the level a chart proposal appends; readers find the proposed price through it. */
export function chartExitLevelId(token: number): string {
  return `chart:${token}`;
}
/** Patch only the selected leg; existing allocated levels are never replaced by a legacy pair. */
export function chartProtectionPatch<T extends Brackets>(parent: T, leg: ChartProtectionLeg, price: number): T {
  if (!Number.isFinite(price)) throw new TradingError("invalid-input", "Choose a valid protection price.");
  if (parent.exitLevels?.length)
    throw new TradingError("unsupported", "Edit an existing protection level or use the ticket to add a level.");
  if (leg === "stopLoss" && (parent.trailingStopPips !== undefined || parent.guaranteedStop !== undefined))
    throw new TradingError("unsupported", "Use the ticket to change this stop style.");
  return { ...parent, [leg]: price };
}

/** One session-owned proposal, separate from broker truth. The ticket and chart share this identity. */
export function createChartOrderEdit(
  state: TradingState,
  context: (id: string, kind: ChartEditKind) => TradingCommandContext,
) {
  const value = new ValueStore<ChartOrderEdit | undefined>(undefined);
  const scope = new DisposalScope();
  let token = 0;
  function clear() {
    value.set(undefined);
  }
  /** Clears only the proposal that a gesture or action started; a newer proposal stays. */
  function clearIf(editToken: number | undefined) {
    if (editToken !== undefined && value.get()?.token === editToken) clear();
  }
  /** A follow-up gesture on the same unchanged entity continues from the pending proposal. */
  function retainedProposal(id: string, kind: ChartEditKind, captured: TradingCommandContext) {
    const previous = value.get();
    if (previous?.id !== id || previous.kind !== kind || previous.context.revision !== captured.revision)
      return undefined;
    return previous.order;
  }
  function assertCurrent(edit: Readonly<ChartOrderEdit>) {
    assertLiveContext(state, edit.context);
    assertRevision(state, edit.kind, edit.id, edit.context.revision);
    const entity = entityStore(state, edit.kind).get(edit.id);
    if (!entity || (edit.kind === "order" && terminalStatuses.has((entity as Order).status)))
      throw new TradingError("stale-context", "This trade is no longer available.");
  }
  const invalidate = () => {
    const edit = value.get();
    if (!edit) return;
    try {
      assertCurrent(edit);
    } catch {
      clear();
    }
  };
  scope.own(state.connection.subscribe(invalidate));
  for (const store of [state.orders, state.positions, state.individualPositions])
    scope.own(store.subscribeChanges(invalidate));
  return {
    state: valueReader(value),
    begin(id: string, kind: ChartEditKind, binding: TradingChartBinding, options: ChartEditOptions = {}) {
      const captured = context(id, kind);
      const entity = entityStore(state, kind).get(id);
      if (!entity || entity.symbol !== binding.symbol)
        throw new TradingError("stale-context", "This trade is no longer available.");
      const order = retainedProposal(id, kind, captured) ?? options.completed ?? entity;
      const edit: ChartOrderEdit = {
        token: ++token,
        id,
        kind,
        binding,
        context: captured,
        order,
        phase: "dragging",
        leg: options.leg,
        multiple: options.multiple ?? false,
        ...(options.level !== undefined ? { level: options.level } : {}),
      };
      assertCurrent(edit);
      value.set(edit);
      return value.get()!;
    },
    propose(price: number, levels?: { entry: number; instrument: InstrumentInfo; maximum?: number }) {
      const edit = value.get();
      if (!edit) throw new TradingError("stale-context", "Review this trade again.");
      assertCurrent(edit);
      if (edit.multiple && edit.leg && edit.level === undefined && !levels)
        throw new TradingError("invalid-input", "Protection details are unavailable.");
      let order = edit.order;
      if (edit.leg) {
        if (edit.level !== undefined) order = moveChartExitLevel(order, edit.level, edit.leg, price);
        else if (edit.multiple && levels)
          order = appendChartExit(
            order,
            edit.leg,
            price,
            levels.entry,
            levels.instrument,
            chartExitLevelId(edit.token),
            levels.maximum,
          );
        else order = chartProtectionPatch(order, edit.leg, price);
      } else if (edit.kind === "order") {
        const original = order as Order;
        order = { ...original, ...(original.type === OrderType.Limit ? { limitPrice: price } : { stopPrice: price }) };
      }
      value.set({ ...edit, order, phase: "reviewing" });
      return value.get()!;
    },
    /** Ticket handoff for an order proposal; `undefined` ends it (closed or settled ticket). */
    sync(order: Readonly<PreOrder | Order>, phase: "reviewing" | "sending" | undefined) {
      const edit = value.get();
      if (!edit || edit.kind !== "order" || !("id" in order) || order.id !== edit.id) return;
      if (!phase) {
        clear();
        return;
      }
      value.set({ ...edit, order: order as Readonly<Order>, phase });
    },
    syncPosition(brackets: Brackets) {
      const edit = value.get();
      if (!edit || edit.kind === "order") return;
      value.set({ ...edit, order: { ...edit.order, ...brackets }, phase: "reviewing" });
    },
    clear,
    clearIf,
    assertCurrent,
    destroy() {
      scope.destroy();
      value.destroy();
    },
  };
}
