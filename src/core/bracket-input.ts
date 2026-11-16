import { monetaryPointValue } from "./financial-rules.js";
import { StopType } from "../contracts/broker.js";
import type {
  Brackets,
  InstrumentInfo,
  Side,
} from "../contracts/broker.js";
import { effectiveTick, snapToStep } from "./trading-rules.js";
export const bracketInputUnits = [
  "price",
  "distance",
  "percentage",
  "money",
  "equityPercentage",
] as const;
export type BracketInputUnit = (typeof bracketInputUnits)[number];
export function isBracketInputUnit(value: string): value is BracketInputUnit {
  return bracketInputUnits.some((unit) => unit === value);
}
export interface BracketInputContext {
  readonly entry?: number;
  readonly side: Side;
  readonly profit: boolean;
  readonly instrument: InstrumentInfo;
  readonly quantity?: number;
  readonly equity?: number;
  readonly moneyCurrency?: "account" | "instrument";
  readonly accountCurrency?: string;
  /** Account-currency value of one pip per quantity unit. */
  readonly pipValue?: number;
}
function distanceUnit(context: BracketInputContext): number | undefined {
  const unit = context.instrument.pipSize ?? context.instrument.minTick;
  return Number.isFinite(unit) && unit > 0 ? unit : undefined;
}
function pricePerInputUnit(
  unit: BracketInputUnit,
  context: BracketInputContext,
): number | undefined {
  if (unit === "percentage") return Math.abs(context.entry ?? NaN) / 100;
  if (unit !== "money" && unit !== "equityPercentage")
    return distanceUnit(context);
  const { quantity } = context;
  if (!quantity || quantity <= 0 || !Number.isFinite(quantity))
    return undefined;
  const pointValue = monetaryPointValue({
    instrument: context.instrument,
    pipValue: context.pipValue,
    currency:
      unit === "equityPercentage"
        ? "account"
        : (context.moneyCurrency ?? "account"),
    accountCurrency: context.accountCurrency,
  });
  if (!pointValue) return undefined;
  let money = 1;
  if (unit === "equityPercentage") {
    if (
      !context.equity ||
      !Number.isFinite(context.equity) ||
      context.equity <= 0
    )
      return undefined;
    money = context.equity / 100;
  }
  const value = money / (quantity * pointValue);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
/** Signed distance is positive on the protective side; wrong-side prices remain visible for validation. */
export function bracketInputValue(
  price: number | undefined,
  unit: BracketInputUnit,
  context: BracketInputContext,
): number | undefined {
  if (price === undefined || !Number.isFinite(price)) return undefined;
  if (unit === "price") return price;
  if (context.entry === undefined || !Number.isFinite(context.entry))
    return undefined;
  const difference =
    (price - context.entry) * context.side * (context.profit ? 1 : -1);
  const divisor = pricePerInputUnit(unit, context);
  if (!divisor) return undefined;
  const result = difference / divisor;
  return Number.isFinite(result) ? Number(result.toPrecision(12)) : undefined;
}
/**
 * Converting a distance produces a price; typed price values are never silently rounded.
 * `snap: false` keeps the exact price for fields stored as a distance (trailing stops).
 */
export function bracketInputPrice(
  value: number | undefined,
  unit: BracketInputUnit,
  context: BracketInputContext,
  snap = true,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return NaN;
  if (unit === "price") return value;
  if (context.entry === undefined || !Number.isFinite(context.entry))
    return NaN;
  const multiplier = pricePerInputUnit(unit, context);
  if (!multiplier) return NaN;
  const price =
    context.entry +
    value * multiplier * context.side * (context.profit ? 1 : -1);
  if (!snap) return price;
  try {
    return snapToStep(price, effectiveTick(price, context.instrument));
  } catch {
    return NaN;
  }
}

/** Default distance, in pips or ticks, of a new take profit (75) or stop (25) from its reference price. */
export function defaultExitDistance(profit: boolean): number {
  return profit ? 75 : 25;
}
/** Price of a new exit leg its default distance from the reference price. */
export function defaultBracketPrice(
  profit: boolean,
  context: Omit<BracketInputContext, "profit">,
  snap = true,
): number | undefined {
  return bracketInputPrice(defaultExitDistance(profit), "distance", { ...context, profit }, snap);
}
/** The stop style a set of brackets uses: trailing, then guaranteed, then a plain stop loss. */
export function bracketStopType(brackets: Readonly<Brackets>): StopType | undefined {
  if (brackets.trailingStopPips !== undefined) return StopType.TrailingStop;
  if (brackets.guaranteedStop !== undefined) return StopType.GuaranteedStop;
  if (brackets.stopLoss !== undefined) return StopType.StopLoss;
  return undefined;
}
/** Whether brackets carry any kind of stop. */
export function hasStop(brackets: Readonly<Brackets>): boolean {
  return bracketStopType(brackets) !== undefined;
}
