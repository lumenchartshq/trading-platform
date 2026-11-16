import type {
  ExitLevel,
  ExitLevelTemplate,
  InstrumentInfo,
  Side,
} from "../contracts/broker.js";
import {
  bracketInputPrice,
  type BracketInputUnit,
} from "./bracket-input.js";

export interface ExitTemplateContext {
  readonly entry?: number;
  readonly side: Side;
  readonly instrument: InstrumentInfo;
  readonly equity?: number;
  /** Account-currency value of one pip per quantity unit, for the order side. */
  readonly pipValue?: number;
  readonly accountCurrency?: string;
}
const templateFields = [
  ["tpPips", "distance", true],
  ["tpParentPricePercent", "percentage", true],
  ["tpRiskInCurrency", "money", true],
  ["tpRiskInPercent", "equityPercentage", true],
  ["slPips", "distance", false],
  ["slParentPricePercent", "percentage", false],
  ["slRiskInCurrency", "money", false],
  ["slRiskInPercent", "equityPercentage", false],
] as const satisfies readonly (readonly [
  keyof ExitLevelTemplate,
  BracketInputUnit,
  boolean,
])[];

/**
 * Resolve template exit levels expressed as pips, parent-price percentage, money or equity percentage into prices.
 * An explicit price wins. A value that cannot be resolved (no entry, equity or pip value) becomes NaN so the
 * ticket shows it as invalid instead of inventing a price. Template-only fields are not forwarded to the broker.
 */
export function resolveExitLevelTemplates(
  levels: readonly Readonly<ExitLevelTemplate>[],
  context: ExitTemplateContext,
): ExitLevel[] {
  return levels.map((level) => {
    const resolved: ExitLevel & Partial<ExitLevelTemplate> = { ...level };
    for (const [field, unit, profit] of templateFields) {
      const value = level[field];
      delete resolved[field];
      if (value === undefined) continue;
      const target = profit ? "takeProfit" : "stopLoss";
      const existing = profit
        ? level.takeProfit
        : (level.stopLoss ?? level.guaranteedStop ?? level.trailingStopPips);
      if (existing !== undefined) continue;
      resolved[target] = bracketInputPrice(value, unit, {
        entry: context.entry,
        side: context.side,
        profit,
        instrument: context.instrument,
        quantity: level.qty,
        equity: context.equity,
        pipValue: context.pipValue,
        accountCurrency: context.accountCurrency,
      });
    }
    return resolved;
  });
}
