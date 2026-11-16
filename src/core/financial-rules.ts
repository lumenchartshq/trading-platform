import type { TradingProfitDisplayMode } from "../contracts/ports.js";
import { decimalPlaces } from "./number-precision.js";
import { OrderType, Side } from "../contracts/broker.js";
import type {
  IndividualPosition,
  InstrumentInfo,
  Order,
  PipValues,
  Position,
  PreOrder,
  QuantityMetainfo,
  TradingQuotes,
} from "../contracts/broker.js";
import { floorToStep } from "./trading-rules.js";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number =>
  finite(value) && value > 0;
export type ProfitDisplayMode =
  TradingProfitDisplayMode;
/** Broker pip values are already in account currency; never multiply by an invented FX rate. */
export function sidePipValue(
  side: Side,
  instrument: InstrumentInfo,
  dynamic?: PipValues,
): number | undefined {
  const value = dynamic
    ? side === Side.Buy
      ? dynamic.buyPipValue
      : dynamic.sellPipValue
    : instrument.pipValue;
  return positive(value) ? value : undefined;
}
/** Account-currency value of one minimum tick for one quantity unit. */
export function instrumentTickValue(
  side: Side,
  instrument: InstrumentInfo,
  dynamic?: PipValues,
): number | undefined {
  const pip = sidePipValue(side, instrument, dynamic);
  const size = instrument.pipSize ?? instrument.minTick;
  if (pip === undefined || !positive(size) || !positive(instrument.minTick))
    return undefined;
  const result = (pip * instrument.minTick) / size;
  return positive(result) ? result : undefined;
}
export function executablePrice(
  side: Side,
  quotes?: TradingQuotes,
): number | undefined {
  const value = side === Side.Buy ? quotes?.ask : quotes?.bid;
  if (finite(value)) return value;
  return finite(quotes?.trade) ? quotes.trade : undefined;
}
export function liquidationPrice(
  side: Side,
  quotes?: TradingQuotes,
): number | undefined {
  return executablePrice(oppositeSide(side), quotes);
}
export function orderEntryPrice(
  order: PreOrder,
  quotes?: TradingQuotes,
): number | undefined {
  if (order.type === OrderType.Market)
    return executablePrice(order.side, quotes);
  if (order.type === OrderType.Limit || order.type === OrderType.StopLimit)
    return finite(order.limitPrice) ? order.limitPrice : undefined;
  return finite(order.stopPrice) ? order.stopPrice : undefined;
}
/**
 * Price a position's TP/SL must sit around: the current price it would close at (bid for a long, ask for a
 * short), so a stop can trail into profit; the entry price when no quote is available.
 */
export function positionProtectionReference(
  position: Readonly<Position | IndividualPosition>,
  quotes?: TradingQuotes,
): number | undefined {
  return liquidationPrice(position.side, quotes) ?? entityEntryPrice("position", position);
}
/** Entry price of a working order, net position (average) or individual position (fill). */
export function entityEntryPrice(
  kind: "order" | "position" | "individualPosition",
  entity: Readonly<Order | Position | IndividualPosition>,
): number | undefined {
  if (kind === "order") return orderEntryPrice(entity as Order);
  if ("avgPrice" in entity) return entity.avgPrice;
  if ("price" in entity) return entity.price;
  return undefined;
}
export function oppositeSide(side: Side): Side {
  return side === Side.Buy ? Side.Sell : Side.Buy;
}
export function positionProfit(input: {
  readonly position: Pick<Position, "side" | "qty" | "avgPrice" | "extra">;
  readonly instrument: InstrumentInfo;
  readonly quotes?: TradingQuotes;
  readonly pipValues?: PipValues;
  readonly mode: ProfitDisplayMode;
  readonly supportPLUpdate: boolean;
  readonly source: "chart" | "table";
  readonly tablePL?: number;
  /** `positionPLInInstrumentCurrency`: money estimates stay in the instrument currency (no pip value conversion). */
  readonly inInstrumentCurrency?: boolean;
}): number | undefined {
  const { position, instrument } = input;
  if (input.mode === "money" && input.supportPLUpdate) {
    const supplied =
      input.source === "table" && finite(input.tablePL)
        ? input.tablePL
        : position.extra?.pl;
    return finite(supplied) ? supplied : undefined;
  }
  const exit = liquidationPrice(position.side, input.quotes);
  if (!finite(exit) || !finite(position.avgPrice) || !positive(position.qty))
    return undefined;
  const difference = (exit - position.avgPrice) * position.side;
  if (!finite(difference)) return undefined;
  if (input.mode === "percentage") {
    if (position.avgPrice === 0) return undefined;
    const percentage = (difference / position.avgPrice) * 100;
    return finite(percentage) ? percentage : undefined;
  }
  const pipSize = positive(instrument.pipSize)
    ? instrument.pipSize
    : instrument.minTick;
  if (!positive(pipSize)) return undefined;
  if (input.mode === "ticks") {
    const ticks = difference / pipSize;
    return finite(ticks) ? ticks : undefined;
  }
  if (input.inInstrumentCurrency) {
    const point = instrumentPointValue(instrument);
    if (point === undefined) return undefined;
    const money = (difference * position.qty * point) / (instrument.priceMagnifier ?? 1);
    return finite(money) ? money : undefined;
  }
  const pipValue = sidePipValue(position.side, instrument, input.pipValues);
  if (pipValue === undefined || !positive(instrument.pipSize)) return undefined;
  const result = (difference * position.qty * pipValue) / pipSize;
  return finite(result) ? result : undefined;
}
/** Precision needed to retain the smallest tick as a fraction of the displayed pip unit. */
export function profitTickPrecision(
  instrument: InstrumentInfo,
): number | undefined {
  const unit = positive(instrument.pipSize)
    ? instrument.pipSize
    : instrument.minTick;
  if (!positive(unit) || !positive(instrument.minTick)) return undefined;
  const ratio = instrument.minTick / unit;
  if (!positive(ratio)) return undefined;
  return decimalPlaces(Number(ratio.toPrecision(12)));
}
export function riskBudget(
  value: number,
  kind: "money" | "percentage",
  equity?: number,
): number | undefined {
  if (!positive(value)) return undefined;
  if (kind === "money") return value;
  if (!positive(equity)) return undefined;
  const result = equity * (value / 100);
  return positive(result) ? result : undefined;
}
export interface RiskSizingContext {
  readonly entry?: number;
  readonly stop?: number;
  readonly instrument: InstrumentInfo;
  readonly side: Side;
  readonly pipValues?: PipValues;
  readonly currency: "account" | "instrument";
  readonly accountCurrency?: string;
}
/** Value of one price point per quantity unit, in the explicitly selected currency. */
export function monetaryPointValue(input: {
  readonly instrument: InstrumentInfo;
  readonly pipValue?: number;
  readonly currency: "account" | "instrument";
  readonly accountCurrency?: string;
}): number | undefined {
  const { instrument } = input;
  if (input.currency === "instrument" && !instrument.currency) return undefined;
  let value: number | undefined;
  if (
    input.currency === "instrument" &&
    instrument.currency !== input.accountCurrency
  ) {
    if (
      !instrument.currency ||
      !positive(instrument.bigPointValue) ||
      !positive(instrument.priceMagnifier ?? 1)
    )
      return undefined;
    value = instrument.bigPointValue / (instrument.priceMagnifier ?? 1);
  } else if (positive(input.pipValue) && positive(instrument.pipSize)) {
    value = input.pipValue / instrument.pipSize;
  }
  return positive(value) ? value : undefined;
}
/** Monetary loss for one quantity unit at the stop, in the selected known currency. */
export function riskPerUnit(input: RiskSizingContext): number | undefined {
  const { instrument, entry, stop } = input;
  if (!finite(entry) || !finite(stop) || entry === stop) return undefined;
  const perPoint = monetaryPointValue({
    instrument,
    pipValue: sidePipValue(input.side, instrument, input.pipValues),
    currency: input.currency,
    accountCurrency: input.accountCurrency,
  });
  if (!positive(perPoint)) return undefined;
  const value = Math.abs(entry - stop) * perPoint;
  return positive(value) ? value : undefined;
}
export function quantityForRisk(
  input: RiskSizingContext & { readonly budget?: number },
):
  | {
      readonly qty: number;
      readonly perUnitRisk: number;
      readonly actualRisk: number;
    }
  | undefined {
  const { instrument, budget } = input;
  const perUnitRisk = riskPerUnit(input);
  if (
    !positive(budget) ||
    !positive(perUnitRisk) ||
    !positive(instrument.qty.step) ||
    !positive(instrument.qty.max)
  )
    return undefined;
  const qty = floorToStep(
    Math.min(budget / perUnitRisk, instrument.qty.max),
    instrument.qty.step,
  );
  if (!positive(qty) || qty < instrument.qty.min || qty > instrument.qty.max)
    return undefined;
  return Object.freeze({ qty, perUnitRisk, actualRisk: qty * perUnitRisk });
}
export function cryptoBaseQuantity(
  quoteAmount: number,
  price: number | undefined,
  quantity: QuantityMetainfo,
): number | undefined {
  if (!positive(quoteAmount) || !positive(price) || !positive(quantity.step))
    return undefined;
  const result = floorToStep(quoteAmount / price, quantity.step);
  return positive(result) && result >= quantity.min && result <= quantity.max
    ? result
    : undefined;
}
export function cryptoQuoteAmount(
  baseQuantity: number,
  price?: number,
): number | undefined {
  if (!positive(baseQuantity) || !positive(price)) return undefined;
  const result = baseQuantity * price;
  return positive(result) ? result : undefined;
}
/** Notional/margin is shown only when its monetary unit is known and compatible. */
/** Instrument-currency value of one price unit per quantity: big point value, lot size, or 1 for stocks/crypto. */
/**
 * Money per one-point price move per unit of quantity. Only stocks and spot crypto default to 1; a futures contract's
 * multiplier is a broker fact (`bigPointValue`), never guessed, so a missing one leaves money estimates unavailable.
 */
export function instrumentPointValue(instrument: InstrumentInfo): number | undefined {
  if (!positive(instrument.priceMagnifier ?? 1)) return undefined;
  const value =
    instrument.bigPointValue ??
    instrument.lotSize ??
    (instrument.type === "stock" || instrument.type === "crypto"
      ? 1
      : undefined);
  return positive(value) ? value : undefined;
}
export function orderNotional(
  qty: number,
  price: number | undefined,
  instrument: InstrumentInfo,
): number | undefined {
  if (
    !positive(qty) ||
    !finite(price) ||
    !instrument.currency ||
    !positive(instrument.bigPointValue ?? 1) ||
    !positive(instrument.priceMagnifier ?? 1)
  )
    return undefined;
  const pointValue = instrumentPointValue(instrument);
  if (pointValue === undefined) return undefined;
  const value = Math.abs(
    (qty * price * pointValue) / (instrument.priceMagnifier ?? 1),
  );
  return finite(value) ? value : undefined;
}
export function marginRequired(
  notional: number | undefined,
  marginRate: number | undefined,
  instrumentCurrency?: string,
  accountCurrency?: string,
): number | undefined {
  if (
    !finite(notional) ||
    notional < 0 ||
    !finite(marginRate) ||
    marginRate < 0 ||
    !instrumentCurrency ||
    instrumentCurrency !== accountCurrency
  )
    return undefined;
  const value = notional * marginRate;
  return finite(value) ? value : undefined;
}
