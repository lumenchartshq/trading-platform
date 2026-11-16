import { OrderType, Side } from "../contracts/broker.js";
import type {
  InstrumentInfo,
  PreOrder,
  QuantityMetainfo,
  TradingQuotes,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { durationsForType } from "./capabilities.js";
import { withDefaultDuration } from "./order-duration.js";
import { TradingError } from "./errors.js";
import { finite } from "./entity-validation.js";
interface Decimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}
function decimal(value: number): Decimal {
  finite(value, "number");
  const [mantissa, exponentText] = String(value).toLowerCase().split("e");
  const [whole, fractional = ""] = mantissa.split(".");
  const exponent = Number(exponentText ?? 0) - fractional.length;
  const numerator = BigInt(whole + fractional);
  if (exponent >= 0)
    return { numerator: numerator * 10n ** BigInt(exponent), denominator: 1n };
  return { numerator, denominator: 10n ** BigInt(-exponent) };
}
export function sumExceeds(
  values: readonly number[],
  maximum: number,
): boolean {
  const decimals = [...values, maximum].map(decimal);
  const denominator = decimals.reduce(
    (largest, value) =>
      value.denominator > largest ? value.denominator : largest,
    1n,
  );
  const total = decimals
    .slice(0, -1)
    .reduce(
      (sum, value) => sum + value.numerator * (denominator / value.denominator),
      0n,
    );
  const limit = decimals[decimals.length - 1];
  return total > limit.numerator * (denominator / limit.denominator);
}
export function aligned(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return false;
  const a = decimal(value),
    b = decimal(step);
  return (a.numerator * b.denominator) % (a.denominator * b.numerator) === 0n;
}
export function alignedFrom(
  value: number,
  origin: number,
  step: number,
): boolean {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(origin) ||
    !Number.isFinite(step) ||
    step <= 0
  )
    return false;
  const a = decimal(value),
    b = decimal(origin),
    c = decimal(step);
  return (
    ((a.numerator * b.denominator - b.numerator * a.denominator) *
      c.denominator) %
      (a.denominator * b.denominator * c.numerator) ===
    0n
  );
}
export function floorToStep(value: number, step: number): number {
  if (
    value < 0 ||
    !Number.isFinite(value) ||
    step <= 0 ||
    !Number.isFinite(step)
  )
    throw new TradingError("invalid-input", "Invalid quantity step.");
  const a = decimal(value),
    b = decimal(step);
  const count = (a.numerator * b.denominator) / (a.denominator * b.numerator);
  return Number(count * b.numerator) / Number(b.denominator);
}
export function snapToStep(value: number, step: number): number {
  finite(value, "price");
  finite(step, "price step");
  if (step <= 0) throw new TradingError("invalid-input", "Invalid price step.");
  const a = decimal(value),
    b = decimal(step);
  const numerator = a.numerator * b.denominator,
    denominator = a.denominator * b.numerator;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return (
    Number((negative ? -rounded : rounded) * b.numerator) /
    Number(b.denominator)
  );
}
export function effectiveTick(
  price: number,
  instrument: Pick<InstrumentInfo, "minTick" | "variableMinTick">,
): number {
  finite(instrument.minTick, "minimum tick");
  if (!instrument.variableMinTick) return instrument.minTick;
  const parts = instrument.variableMinTick.trim().split(/\s+/).map(Number);
  if (parts.length % 2 !== 1 || parts.some((n) => !Number.isFinite(n)))
    throw new TradingError("invalid-input", "Invalid variable tick schedule.");
  for (let i = 0; i < parts.length; i += 2) {
    if (
      parts[i] <= 0 ||
      (i + 1 < parts.length && i > 0 && parts[i + 1] <= parts[i - 1])
    )
      throw new TradingError(
        "invalid-input",
        "Invalid variable tick schedule.",
      );
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (i + 1 === parts.length || price < parts[i + 1]) return parts[i];
  }
  throw new TradingError("invalid-input", "Invalid variable tick schedule.");
}
export function validateQuantity(
  quantity: number,
  rules: QuantityMetainfo,
): void {
  finite(quantity, "quantity");
  if (
    quantity <= 0 ||
    quantity < rules.min ||
    quantity > rules.max ||
    !aligned(quantity, rules.step)
  )
    throw new TradingError(
      "invalid-input",
      "Enter a quantity within the allowed range and step.",
    );
}
export function executablePrice(
  side: Side,
  quotes?: TradingQuotes,
): number | undefined {
  const price = side === Side.Buy ? quotes?.ask : quotes?.bid;
  if (typeof price === "number" && Number.isFinite(price)) return price;
  return undefined;
}
export function validatePreOrder(
  order: PreOrder,
  instrument: InstrumentInfo,
  policy: CapabilityPolicy,
  quotes: TradingQuotes | undefined,
  now: number,
  /** The session clock may run ahead of the broker's; an expiry this close to now is left to the broker. */
  clockSkewToleranceSeconds = 60,
): void {
  order = withDefaultDuration(order, policy, instrument);
  if (!order.symbol || ![Side.Buy, Side.Sell].includes(order.side))
    throw new TradingError("invalid-input", "Choose a symbol and trade side.");
  validateQuantity(order.qty, instrument.qty);
  const type = order.type ?? OrderType.Market;
  if (
    !policy.orderTypes.includes(type) ||
    (instrument.allowedOrderTypes &&
      !instrument.allowedOrderTypes.includes(type))
  )
    throw new TradingError("unsupported", "This order type is unavailable.");
  const limit = type === OrderType.Limit || type === OrderType.StopLimit;
  const stop = type === OrderType.Stop || type === OrderType.StopLimit;
  for (const [required, price, override] of [
    [limit, order.limitPrice, instrument.limitPriceStep],
    [stop, order.stopPrice, instrument.stopPriceStep],
  ] as const) {
    if (!required) continue;
    finite(price, "order price");
    if (!aligned(price, override ?? effectiveTick(price, instrument)))
      throw new TradingError(
        "invalid-input",
        "Enter a price aligned to the instrument step.",
      );
  }
  const quote = executablePrice(order.side, quotes);
  const touchedStop =
    type === OrderType.Stop
      ? policy.flags.supportStopOrdersInBothDirections
      : policy.flags.supportStopLimitOrdersInBothDirections;
  if (
    (stop && !touchedStop) ||
    (limit && policy.flags.supportStrictCheckingLimitOrderPrice)
  ) {
    if (quote === undefined)
      throw new TradingError(
        "invalid-input",
        "A current quote is needed to check this price.",
      );
    const direction = order.side;
    if (
      stop &&
      !touchedStop &&
      ((order.stopPrice as number) - quote) * direction <= 0
    )
      throw new TradingError(
        "invalid-input",
        "The stop price is on the wrong side of the market.",
      );
    if (
      limit &&
      policy.flags.supportStrictCheckingLimitOrderPrice &&
      ((order.limitPrice as number) - quote) * direction > 0
    )
      throw new TradingError(
        "invalid-input",
        "The limit price is on the wrong side of the market.",
      );
  }
  if (order.duration) {
    const supported = durationsForType(policy, type).find(
      (duration) => duration.value === order.duration?.type,
    );
    if (
      !supported ||
      (instrument.allowedDurations &&
        !instrument.allowedDurations.includes(order.duration.type))
    )
      throw new TradingError("unsupported", "This duration is unavailable.");
    if (supported.hasDatePicker || supported.hasTimePicker) {
      finite(order.duration.datetime, "expiration");
      if ((order.duration.datetime as number) * 1000 <= now - Math.max(0, clockSkewToleranceSeconds) * 1000)
        throw new TradingError("invalid-input", "Choose a future expiration.");
    }
  }
}
