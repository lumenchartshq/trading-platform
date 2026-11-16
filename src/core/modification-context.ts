import type { Order } from "../contracts/broker.js";
import { bracketParent, type BracketParentKind } from "./bracket-parent.js";
import { terminalStatuses } from "./entity-validation.js";
import { TradingError } from "./errors.js";
import type { TradingState } from "./trading-state.js";

type ModificationState = {
  readonly [K in "orders" | "positions" | "individualPositions"]: Pick<TradingState[K], "get" | "revision">;
};

export interface ModificationParentContext {
  readonly kind: BracketParentKind;
  readonly id: string;
  readonly revision: number;
}
function parentStore(state: ModificationState, kind: BracketParentKind) {
  if (kind === "order") return state.orders;
  if (kind === "position") return state.positions;
  return state.individualPositions;
}
export function captureModificationParent(
  state: ModificationState,
  id: string,
): ModificationParentContext | undefined {
  const order = state.orders.get(id);
  const parent = order && bracketParent(order);
  return parent
    ? Object.freeze({
        kind: parent.kind,
        id: parent.id,
        revision: parentStore(state, parent.kind).revision(parent.id),
      })
    : undefined;
}
/** The called child and its owner form one review identity, even when their IDs happen to match. */
export function assertModificationParent(
  state: ModificationState,
  order: Readonly<Order>,
  context?: ModificationParentContext,
) {
  const parent = bracketParent(order);
  if (!parent && !("parentId" in order) && !context) return undefined;
  if (
    !parent ||
    !context ||
    parent.kind !== context.kind ||
    parent.id !== context.id
  )
    throw new TradingError(
      "stale-context",
      "This protection order changed. Review its current details.",
    );
  const store = parentStore(state, parent.kind);
  const value = store.get(parent.id);
  if (
    !value ||
    store.revision(parent.id) !== context.revision ||
    value.qty <= 0 ||
    value.symbol !== order.symbol ||
    value.side !== -order.side ||
    (parent.kind === "order" &&
      "status" in value &&
      terminalStatuses.has(value.status))
  )
    throw new TradingError(
      "stale-context",
      "The parent trade changed. Review its current protection.",
    );
  return { ...parent, value };
}

/** True when a protection child's owner is present and live; an orphan may be cancelled but not edited. */
export function modificationParentAvailable(
  state: ModificationState,
  order: Readonly<Order>,
): boolean {
  const parent = bracketParent(order);
  if (!parent) return !("parentId" in order) || !order.parentId;
  const value = parentStore(state, parent.kind).get(parent.id);
  return (
    !!value &&
    value.qty > 0 &&
    value.symbol === order.symbol &&
    value.side === -order.side &&
    !(
      parent.kind === "order" &&
      "status" in value &&
      terminalStatuses.has(value.status)
    )
  );
}
