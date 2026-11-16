import type { InstrumentInfo } from "../contracts/broker.js";
import { effectiveTick, snapToStep } from "./trading-rules.js";
export function relativePriceTicks(
  price: number | undefined,
  anchor: number | undefined,
  instrument: InstrumentInfo,
): number | undefined {
  if (
    price === undefined ||
    anchor === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(anchor) ||
    !Number.isFinite(instrument.minTick) ||
    !(instrument.minTick > 0)
  )
    return undefined;
  const result = (price - anchor) / instrument.minTick;
  return Number.isFinite(result) ? Number(result.toPrecision(12)) : undefined;
}
/** A tick offset is a generated price. Directly typed prices still pass through unchanged. */
export function priceFromTicks(
  ticks: number,
  anchor: number | undefined,
  instrument: InstrumentInfo,
  kind: "limit" | "stop",
): number {
  if (
    !Number.isFinite(ticks) ||
    anchor === undefined ||
    !Number.isFinite(anchor) ||
    !Number.isFinite(instrument.minTick) ||
    !(instrument.minTick > 0)
  )
    return NaN;
  const price = anchor + ticks * instrument.minTick;
  try {
    const step =
      kind === "limit" ? instrument.limitPriceStep : instrument.stopPriceStep;
    return snapToStep(price, step ?? effectiveTick(price, instrument));
  } catch {
    return NaN;
  }
}
