import type {
  Brackets,
  ExitLevel,
  QuantityMetainfo,
} from "../contracts/broker.js";
import { TradingError } from "./errors.js";
import {
  floorToStep,
  snapToStep,
  sumExceeds,
  validateQuantity,
} from "./trading-rules.js";

/** A UI identity is retained until the broker supplies an authoritative exit-level identity. */
export function legacyExitLevel(
  brackets: Readonly<Brackets>,
  quantity: number,
  id: string,
): ExitLevel {
  return {
    id,
    qty: quantity,
    takeProfit: brackets.takeProfit,
    stopLoss: brackets.stopLoss,
    guaranteedStop: brackets.guaranteedStop,
    trailingStopPips: brackets.trailingStopPips,
    isExisting: false,
  };
}
/** The broker minimum need not itself be aligned to its quantity step. */
export function minimumExitQuantity(rules: QuantityMetainfo): number {
  const base = floorToStep(Math.max(rules.min, rules.step), rules.step);
  const value =
    base < rules.min ? snapToStep(base + rules.step, rules.step) : base;
  validateQuantity(value, rules);
  return value;
}
/** Adding a level can reclaim allocation from the last levels, preserving their minimum sizes. */
export function appendExitLevel(
  current: readonly Readonly<ExitLevel>[],
  candidate: Readonly<ExitLevel>,
  parentQuantity: number,
  rules: QuantityMetainfo,
  maximum?: number,
): ExitLevel[] {
  validateQuantity(parentQuantity, rules);
  if (maximum !== undefined && (!Number.isInteger(maximum) || maximum < 1))
    throw new TradingError(
      "configuration",
      "The broker returned an invalid exit level limit.",
    );
  if (maximum !== undefined && current.length >= maximum)
    throw new TradingError(
      "invalid-input",
      "The maximum number of exit levels has been reached.",
    );
  const ids = new Set<string>();
  for (const level of [...current, candidate]) {
    if (!level.id || ids.has(level.id))
      throw new TradingError(
        "invalid-input",
        "Exit levels need unique identities.",
      );
    ids.add(level.id);
    validateQuantity(level.qty, rules);
  }
  if (
    sumExceeds(
      current.map((level) => level.qty),
      parentQuantity,
    )
  )
    throw new TradingError(
      "invalid-input",
      "Reduce the protected quantity before adding another level.",
    );
  const levels: ExitLevel[] = current.map((level) => ({
    ...structuredClone(level),
  }));
  const minimum = minimumExitQuantity(rules);
  // Inputs are aligned; snap only generated allocation arithmetic to remove binary rounding noise.
  const occupied = snapToStep(
    current.reduce((sum, level) => sum + level.qty, 0),
    rules.step,
  );
  let reclaim = snapToStep(
    Math.max(occupied + candidate.qty - parentQuantity, 0),
    rules.step,
  );
  for (let index = levels.length - 1; index >= 0 && reclaim > 0; index--) {
    const available = snapToStep(
      Math.max(levels[index].qty - minimum, 0),
      rules.step,
    );
    const reduction = Math.min(available, reclaim);
    levels[index].qty = snapToStep(levels[index].qty - reduction, rules.step);
    reclaim = snapToStep(reclaim - reduction, rules.step);
  }
  if (reclaim > 0)
    throw new TradingError(
      "invalid-input",
      "Increase the quantity before adding another exit level.",
    );
  const result = [...levels, structuredClone(candidate)];
  if (
    sumExceeds(
      result.map((level) => level.qty),
      parentQuantity,
    )
  )
    throw new TradingError(
      "invalid-input",
      "Protected quantity exceeds the parent quantity.",
    );
  return result;
}
/** Removing a level does not expand another level's allocation or mutate broker-owned data. */
export function removeExitLevel(
  current: readonly Readonly<ExitLevel>[],
  id: string,
): ExitLevel[] {
  return current
    .filter((level) => level.id !== id)
    .map((level) => structuredClone(level));
}
