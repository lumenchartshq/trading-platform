import { sameAccountGeneration } from "./identity.js";
import type { TradingState } from "./trading-state.js";
import { TradingError } from "./errors.js";

export interface AccountContext {
  readonly accountId: string;
  readonly generation: number;
}
export type TradingEntityKind = "order" | "position" | "individualPosition";

interface EntityStores {
  order: TradingState["orders"];
  position: TradingState["positions"];
  individualPosition: TradingState["individualPositions"];
}
export function entityStore<K extends TradingEntityKind>(state: TradingState, kind: K): EntityStores[K];
export function entityStore(state: TradingState, kind: TradingEntityKind) {
  if (kind === "position") return state.positions;
  if (kind === "individualPosition") return state.individualPositions;
  return state.orders;
}

export function isLiveContext(state: TradingState, context: AccountContext): boolean {
  const connection = state.connection.get();
  return connection.phase === "ready" &&
    sameAccountGeneration(connection, context);
}

export function assertLiveContext(state: TradingState, context: AccountContext): void {
  const connection = state.connection.get();
  if (connection.phase === "disposed")
    throw TradingError.disposed();
  if (connection.phase !== "ready")
    throw TradingError.disconnected();
  if (!isLiveContext(state, context))
    throw TradingError.accountChanged();
}

export function assertRevision(
  state: TradingState,
  kind: TradingEntityKind,
  id: string,
  revision: number | undefined,
): void {
  // Entity commands capture their revision through `commands.context(id, kind)`.
  if (revision === undefined)
    throw new TradingError("invalid-input", "This action needs the item's current details. Try again.");
  if (entityStore(state, kind).revision(id) === revision) return;
  const name = kind === "order" ? "order" : "position";
  throw new TradingError("stale-context", `This ${name} changed. Review its current details.`);
}
