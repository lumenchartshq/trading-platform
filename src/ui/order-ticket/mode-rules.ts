import { isRiskQuantityMode, type QuantityInputMode } from "../../core/quantity-input.js";
import type { BracketInputUnit } from "../../core/bracket-input.js";
export function effectiveQuantityMode(mode: QuantityInputMode, riskAllowed: boolean, stop: number | undefined): QuantityInputMode {
  if (isRiskQuantityMode(mode) && (!riskAllowed || stop === undefined)) return "units";
  return mode;
}
export function effectiveExitMode(mode: BracketInputUnit, allowMoney: boolean): BracketInputUnit {
  if ((mode === "money" || mode === "equityPercentage") && !allowMoney) return "price";
  return mode;
}
