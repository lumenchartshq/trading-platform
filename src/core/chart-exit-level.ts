import type { Brackets, InstrumentInfo, ExitLevel } from "../contracts/broker.js";
import type { TradingProtectionLeg as ChartProtectionLeg } from "../contracts/ports.js";
import { appendExitLevel, legacyExitLevel, minimumExitQuantity } from "./exit-level-draft.js";
import { effectiveTick, snapToStep } from "./trading-rules.js";
import { TradingError } from "./errors.js";

/** Chart-created allocated levels are paired; use an explicit 1:1 mirror for the new opposite leg. */
export function appendChartExit<T extends Brackets & { qty: number }>(
  parent: T,
  leg: ChartProtectionLeg,
  price: number,
  entry: number,
  instrument: InstrumentInfo,
  id: string,
  maximum?: number,
): T {
  if (parent.trailingStopPips !== undefined || parent.guaranteedStop !== undefined)
    throw new TradingError("unsupported", "Use the ticket to add levels to this stop style.");
  const opposite = snapToStep(
    2 * entry - price,
    (leg === "takeProfit" ? instrument.stopPriceStep : instrument.limitPriceStep) ??
      effectiveTick(2 * entry - price, instrument),
  );
  const pair =
    leg === "takeProfit" ? { takeProfit: price, stopLoss: opposite } : { takeProfit: opposite, stopLoss: price };
  if (!parent.exitLevels?.length && parent.takeProfit === undefined && parent.stopLoss === undefined)
    return { ...parent, ...pair };
  const previous: readonly Readonly<ExitLevel>[] = parent.exitLevels?.length
    ? parent.exitLevels
    : [
        legacyExitLevel(
          { takeProfit: parent.takeProfit ?? pair.takeProfit, stopLoss: parent.stopLoss ?? pair.stopLoss },
          parent.qty,
          `${id}:legacy`,
        ),
      ];
  const exitLevels = appendExitLevel(
    previous,
    { ...pair, id, qty: minimumExitQuantity(instrument.qty), isExisting: false },
    parent.qty,
    instrument.qty,
    maximum,
  );
  return {
    ...parent,
    exitLevels,
    takeProfit: undefined,
    stopLoss: undefined,
    trailingStopPips: undefined,
    guaranteedStop: undefined,
  };
}

/**
 * Moves one leg of an existing allocated level, keeping its ID and quantity so the broker updates that
 * level instead of adding one. Other levels and legs are unchanged.
 */
export function moveChartExitLevel<T extends Brackets>(
  parent: T,
  levelId: string,
  leg: ChartProtectionLeg,
  price: number,
): T {
  if (!Number.isFinite(price)) throw new TradingError("invalid-input", "Choose a valid protection price.");
  const level = parent.exitLevels?.find((value) => value.id === levelId);
  if (!level) throw new TradingError("stale-context", "This exit level changed. Review the trade again.");
  if (leg === "stopLoss" && (level.trailingStopPips !== undefined || level.guaranteedStop !== undefined))
    throw new TradingError("unsupported", "Use the ticket to change this stop style.");
  if (level[leg] === undefined) throw new TradingError("unsupported", "Use the ticket to add this exit to the level.");
  return {
    ...parent,
    exitLevels: parent.exitLevels!.map((value) => (value.id === levelId ? { ...value, [leg]: price } : value)),
  };
}
