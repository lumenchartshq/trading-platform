import type {
  InstrumentInfo,
  PipValues,
  Side,
} from "../contracts/broker.js";
import {
  orderNotional,
  quantityForRisk,
  riskPerUnit,
} from "./financial-rules.js";
import { floorToStep } from "./trading-rules.js";
export type QuantityInputMode =
  "units" | "currency" | "percentage" | "riskMoney" | "riskPercentage";
export interface QuantityInputContext {
  readonly instrument: InstrumentInfo;
  readonly price?: number;
  readonly equity?: number;
  readonly accountCurrency?: string;
  readonly side?: Side;
  readonly stop?: number;
  readonly pipValues?: PipValues;
  readonly riskAllowed?: boolean;
}
export function isQuantityInputMode(value: string): value is QuantityInputMode {
  return [
    "units",
    "currency",
    "percentage",
    "riskMoney",
    "riskPercentage",
  ].includes(value);
}
export function isRiskQuantityMode(mode: QuantityInputMode): boolean {
  return mode === "riskMoney" || mode === "riskPercentage";
}
export function needsQuantityEquity(mode: QuantityInputMode): boolean {
  return mode === "percentage" || mode === "riskPercentage";
}
function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function perUnit(context: QuantityInputContext): number | undefined {
  const value = orderNotional(1, context.price, context.instrument);
  return positive(value) ? value : undefined;
}
function riskContext(context: QuantityInputContext) {
  if (
    !context.riskAllowed ||
    !context.accountCurrency ||
    context.side === undefined
  )
    return undefined;
  return {
    instrument: context.instrument,
    entry: context.price,
    stop: context.stop,
    side: context.side,
    pipValues: context.pipValues,
    currency: "account" as const,
    accountCurrency: context.accountCurrency,
  };
}
function risk(context: QuantityInputContext): number | undefined {
  const input = riskContext(context);
  return input ? riskPerUnit(input) : undefined;
}
export function quantityModeAvailable(
  mode: QuantityInputMode,
  context: QuantityInputContext,
): boolean {
  if (mode === "units") return true;
  if (isRiskQuantityMode(mode))
    return (
      positive(risk(context)) &&
      (mode !== "riskPercentage" || positive(context.equity))
    );
  if (perUnit(context) === undefined) return false;
  if (mode === "currency") return true;
  return (
    positive(context.equity) &&
    !!context.accountCurrency &&
    context.accountCurrency === context.instrument.currency
  );
}
/** Selection can start a missing equity subscription while preserving the current units. */
export function quantityModeSelectable(
  mode: QuantityInputMode,
  context: QuantityInputContext,
): boolean {
  if (mode === "riskPercentage")
    return quantityModeAvailable("riskMoney", context);
  if (mode === "percentage")
    return (
      quantityModeAvailable("currency", context) &&
      !!context.accountCurrency &&
      context.accountCurrency === context.instrument.currency
    );
  return quantityModeAvailable(mode, context);
}
export function quantityInputValue(
  qty: number,
  mode: QuantityInputMode,
  context: QuantityInputContext,
): number | undefined {
  if (!positive(qty) || !quantityModeAvailable(mode, context)) return undefined;
  if (mode === "units") return qty;
  const money = isRiskQuantityMode(mode)
    ? qty * risk(context)!
    : orderNotional(qty, context.price, context.instrument);
  if (money === undefined || !Number.isFinite(money)) return undefined;
  if (!needsQuantityEquity(mode)) return money;
  const percentage = (money / context.equity!) * 100;
  return Number.isFinite(percentage) ? percentage : undefined;
}
/** Converted sizes floor to the broker step. No account/instrument FX rate is inferred. */
export function quantityFromInput(
  value: number,
  mode: QuantityInputMode,
  context: QuantityInputContext,
): number | undefined {
  if (!positive(value) || !quantityModeAvailable(mode, context))
    return undefined;
  if (mode === "units") return value;
  const amount = needsQuantityEquity(mode)
    ? (value / 100) * context.equity!
    : value;
  if (!positive(amount)) return undefined;
  if (isRiskQuantityMode(mode)) {
    const input = riskContext(context);
    return input
      ? quantityForRisk({ ...input, budget: amount })?.qty
      : undefined;
  }
  const step = context.instrument.qty.step;
  if (!positive(step)) return undefined;
  const qty = floorToStep(amount / perUnit(context)!, step);
  if (
    !Number.isFinite(qty) ||
    qty < context.instrument.qty.min ||
    qty > context.instrument.qty.max
  )
    return undefined;
  return qty;
}

export interface SizedQuantityInput {
  readonly mode: QuantityInputMode;
  readonly fallbackMode?: QuantityInputMode;
  readonly disabled: boolean;
  /** The amount typed in a non-unit mode. */
  readonly entered?: number;
  /** A units quantity waiting to be shown in `mode` once its inputs (price, equity) are known. */
  readonly pending?: { readonly mode: QuantityInputMode; readonly qty: number };
  /** The draft's canonical quantity in units. */
  readonly qty: number;
  /** The last positive units quantity, restored when returning to units. */
  readonly lastUnits: number;
  readonly context: QuantityInputContext;
}
/** What the quantity field applies; absent fields mean no change. `sizing` may be NaN (not yet sizeable). */
export interface SizedQuantityResult {
  /** A units quantity to write as the user's own quantity. */
  readonly units?: number;
  /** A quantity derived from a cash or percentage amount. */
  readonly sizing?: number;
  readonly entered?: number;
  readonly clearPending: boolean;
  readonly lastUnits?: number;
}
/**
 * Keeps a cash or percentage amount sized as entry price and equity change; units stay canonical. Returning to
 * units from a risk fallback restores the last positive quantity, writing it only when it differs.
 */
export function resolveSizedQuantity(input: SizedQuantityInput): SizedQuantityResult {
  if (input.mode === "units") {
    if (!input.fallbackMode || !isRiskQuantityMode(input.fallbackMode)) return { clearPending: false };
    const qty = Number.isFinite(input.qty) && input.qty > 0 ? input.qty : input.lastUnits;
    return Object.is(qty, input.qty) ? { clearPending: true } : { clearPending: true, units: qty };
  }
  if (input.disabled) return { clearPending: false };
  let entered = input.entered;
  let converted: number | undefined;
  if (input.pending?.mode === input.mode) {
    converted = quantityInputValue(input.pending.qty, input.mode, input.context);
    if (converted === undefined)
      return Number.isNaN(input.qty) ? { clearPending: false } : { clearPending: false, sizing: NaN };
    entered = converted;
  }
  const qty = quantityFromInput(entered ?? NaN, input.mode, input.context) ?? NaN;
  return {
    clearPending: converted !== undefined,
    ...(converted !== undefined ? { entered: converted } : {}),
    ...(Number.isFinite(qty) && qty > 0 ? { lastUnits: qty } : {}),
    ...(Object.is(qty, input.qty) ? {} : { sizing: qty }),
  };
}
