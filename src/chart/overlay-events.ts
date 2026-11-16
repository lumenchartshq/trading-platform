import type {
  TradingOverlayAction,
  TradingOverlayEvent,
} from "../contracts/ports.js";
import { isOrdinaryDataRecord } from "../core/immutable.js";
import { TradingError } from "../core/errors.js";
const actions = new Set<TradingOverlayAction>([
  "modify",
  "cancel",
  "close",
  "reverse",
  "protect",
  "submit",
]);
const gestures = new Set([
  "dragStart",
  "dragPreview",
  "dragCommit",
  "dragCancel",
]);
/** Snapshot the host callback before any dialog/await can retain mutable provider data. */
export function normalizeOverlayEvent(input: unknown): TradingOverlayEvent {
  if (!isOrdinaryDataRecord(input)) throw invalid();
  const field = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) throw invalid();
    return descriptor.value;
  };
  const type = field("type");
  if (typeof type !== "string") throw invalid();
  if (actions.has(type as TradingOverlayAction))
    return Object.freeze({ type: type as TradingOverlayAction });
  const gestureId = field("gestureId"),
    price = field("price");
  if (
    !gestures.has(type) ||
    typeof gestureId !== "string" ||
    !gestureId.length ||
    typeof price !== "number" ||
    !Number.isFinite(price)
  )
    throw invalid();
  const leg = field("leg");
  if (leg !== undefined && leg !== "takeProfit" && leg !== "stopLoss") throw invalid();
  return Object.freeze({
    ...(leg ? { leg } : {}),
    type: type as "dragStart" | "dragPreview" | "dragCommit" | "dragCancel",
    gestureId,
    price,
  });
}
function invalid(): TradingError {
  return new TradingError("invalid-input", "This chart action is unavailable.");
}
