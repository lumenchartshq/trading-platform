import { cryptoTicketMode } from "./capabilities.js";
import { OrderType, StopType } from "../contracts/broker.js";
import type {
  Brackets,
  InstrumentInfo,
  Order,
  PreOrder,
  TradingQuotes,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { PROTECTION_FIELDS, normalizeProtection } from "./protection-rules.js";
import { orderEntryPrice } from "./financial-rules.js";
import { TradingError } from "./errors.js";
export function hasOrderProtection(order: PreOrder): boolean {
  return PROTECTION_FIELDS.some((field) =>
    field === "exitLevels"
      ? !!order.exitLevels?.length
      : order[field] !== undefined,
  );
}
export function prepareOrderProtection<T extends PreOrder>(
  order: T,
  instrument: InstrumentInfo,
  policy: CapabilityPolicy,
  quotes?: TradingQuotes,
  maxLevels?: number,
  previous?: Readonly<Order>,
): T {
  if (!hasOrderProtection(order)) return order;
  if (!policy.flags.supportOrderBrackets)
    throw new TradingError("unsupported", "Order protection is unavailable.");
  if (
    (order.type ?? OrderType.Market) === OrderType.Market &&
    !policy.flags.supportMarketBrackets
  )
    throw new TradingError(
      "unsupported",
      "Protection on market orders is unavailable.",
    );
  const crypto = cryptoTicketMode(policy, instrument.type);
  if (crypto && !policy.flags.supportCryptoBrackets)
    throw new TradingError(
      "unsupported",
      "Protection in the crypto ticket is unavailable.",
    );
  if (
    previous &&
    !hasOrderProtection(previous) &&
    !policy.flags.supportAddBracketsToExistingOrder
  )
    throw new TradingError(
      "unsupported",
      "Protection cannot be added to this order.",
    );
  const brackets: Brackets = {};
  for (const field of PROTECTION_FIELDS)
    if (Object.hasOwn(order, field))
      Object.assign(brackets, { [field]: order[field] });
  const normalized = normalizeProtection(
    brackets,
    order.qty,
    instrument,
    policy,
    maxLevels,
    "order",
  );
  const entry = orderEntryPrice(order, quotes);
  if (entry === undefined)
    throw new TradingError(
      "invalid-input",
      "A current entry price is needed to check protection.",
    );
  for (const level of normalized.exitLevels ?? [normalized]) {
    if (
      level.takeProfit !== undefined &&
      (level.takeProfit - entry) * order.side <= 0
    )
      throw new TradingError(
        "invalid-input",
        "Take profit must be on the profit side of the entry price.",
      );
    const stop = level.stopLoss ?? level.guaranteedStop;
    if (stop !== undefined && (stop - entry) * order.side >= 0)
      throw new TradingError(
        "invalid-input",
        "Stop protection must be on the risk side of the entry price.",
      );
  }
  let stopType = order.stopType;
  if (normalized.exitLevels?.length) stopType = undefined;
  else if (normalized.trailingStopPips !== undefined)
    stopType = StopType.TrailingStop;
  else if (normalized.guaranteedStop !== undefined)
    stopType = StopType.GuaranteedStop;
  else if (
    normalized.stopLoss === undefined ||
    stopType === StopType.TrailingStop ||
    stopType === StopType.GuaranteedStop
  )
    stopType = undefined;
  const result = { ...order, ...normalized };
  if (stopType !== order.stopType) result.stopType = stopType;
  return result;
}
