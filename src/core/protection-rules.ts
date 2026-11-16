import { Side } from "../contracts/broker.js";
import type {
  Brackets,
  IndividualPosition,
  InstrumentInfo,
  Position,
  TradingQuotes,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { TradingError } from "./errors.js";
import { positionProtectionReference } from "./financial-rules.js";
import { equalData } from "./immutable.js";
import { assertPositionProtectionPermissions } from "./position-protection-permissions.js";
import {
  aligned,
  effectiveTick,
  sumExceeds,
  validateQuantity,
} from "./trading-rules.js";
const priceFields = ["takeProfit", "stopLoss", "guaranteedStop"] as const;
/**
 * TP/SL must sit on the profitable/protective side of `reference`: the entry for orders, the current
 * price for positions (see `positionProtectionReference`), named in the message as `referenceName`.
 */
export function protectionDirectionError(
  brackets: Readonly<Brackets>,
  side: Side,
  reference: number | undefined,
  referenceName = "entry price",
): string | undefined {
  if (reference === undefined || !Number.isFinite(reference)) return undefined;
  const entry = reference;
  for (const level of brackets.exitLevels?.length ? brackets.exitLevels : [brackets]) {
    if (level.takeProfit !== undefined && (level.takeProfit - entry) * side <= 0)
      return `Take profit must be ${side === Side.Buy ? "above" : "below"} the ${referenceName}.`;
    const stop = level.stopLoss ?? level.guaranteedStop;
    if (stop !== undefined && (stop - entry) * side >= 0)
      return `Stop loss must be ${side === Side.Buy ? "below" : "above"} the ${referenceName}.`;
  }
  return undefined;
}
/** Validates broker protection inputs; never creates, activates or cancels broker children locally. */
export function normalizeProtection(
  input: Brackets,
  quantity: number,
  instrument: InstrumentInfo,
  policy: CapabilityPolicy,
  maxLevels?: number,
  target: "position" | "order" = "position",
): Brackets {
  if (
    maxLevels !== undefined &&
    (!Number.isInteger(maxLevels) || maxLevels < 1)
  )
    throw new TradingError(
      "configuration",
      "The broker returned an invalid protection level limit.",
    );
  const brackets = structuredClone(input);
  const levels = brackets.exitLevels;
  if (levels?.length && !policy.flags.supportMultipleExitLevels)
    throw new TradingError(
      "unsupported",
      "Multiple protection levels are unavailable.",
    );
  if (maxLevels !== undefined && levels && levels.length > maxLevels)
    throw new TradingError(
      "invalid-input",
      "There are too many protection levels.",
    );
  const ids = new Set<string>();

  for (const level of levels ?? []) {
    if (!level.id || ids.has(level.id))
      throw new TradingError(
        "invalid-input",
        "Protection levels need unique identities.",
      );
    ids.add(level.id);
    validateQuantity(level.qty, instrument.qty);
  }
  if (
    sumExceeds(
      (levels ?? []).map((level) => level.qty),
      quantity,
    )
  )
    throw new TradingError(
      "invalid-input",
      "Protected quantity exceeds this position.",
    );
  const entries = levels?.length ? levels : [brackets];
  for (const level of entries) {
    for (const field of priceFields) {
      const value = level[field];
      if (value === undefined) continue;
      if (
        !Number.isFinite(value) ||
        !aligned(value, effectiveTick(value, instrument))
      )
        throw new TradingError(
          "invalid-input",
          "Protection prices must match the instrument step.",
        );
    }
    if (level.stopLoss !== undefined && !policy.flags.supportStopLoss)
      throw new TradingError("unsupported", "Stop loss is unavailable.");
    if (
      level.guaranteedStop !== undefined &&
      !policy.flags.supportGuaranteedStop
    )
      throw new TradingError(
        "unsupported",
        "Guaranteed stops are unavailable.",
      );
    if (
      level.trailingStopPips !== undefined &&
      (!policy.flags.supportTrailingStop ||
        !Number.isFinite(level.trailingStopPips) ||
        level.trailingStopPips <= 0)
    )
      throw new TradingError(
        "invalid-input",
        "Enter a supported positive trailing distance.",
      );
    const stops = [
      level.stopLoss,
      level.guaranteedStop,
      level.trailingStopPips,
    ].filter((value) => value !== undefined);
    if (stops.length > 1)
      throw new TradingError(
        "invalid-input",
        "Choose one stop style for each level.",
      );
    const paired = level.takeProfit !== undefined && stops.length === 1;
    if (levels?.length && !policy.flags.supportUnpairedExitLevels && !paired)
      throw new TradingError(
        "invalid-input",
        "Each protection level needs a take profit and stop.",
      );
    if (levels?.length && level.takeProfit === undefined && stops.length === 0)
      throw new TradingError(
        "invalid-input",
        "Each protection level needs at least one exit.",
      );
    const pairOnly =
      target === "order"
        ? policy.flags.supportOnlyPairOrderBrackets
        : policy.flags.supportOnlyPairPositionBrackets;
    if (pairOnly && (level.takeProfit !== undefined || stops.length) && !paired)
      throw new TradingError(
        "invalid-input",
        "Add take profit and stop protection together.",
      );
  }
  if (levels?.length === 1 && levels[0].qty === quantity) {
    const level = levels[0];
    return {
      takeProfit: level.takeProfit,
      stopLoss: level.stopLoss,
      guaranteedStop: level.guaranteedStop,
      trailingStopPips: level.trailingStopPips,
      exitLevels: undefined,
    };
  }
  if (levels?.length)
    return {
      exitLevels: levels,
      takeProfit: undefined,
      stopLoss: undefined,
      guaranteedStop: undefined,
      trailingStopPips: undefined,
    };
  return brackets;
}

/** The protection fields of an order or position, in one place. */
export const PROTECTION_FIELDS = ["takeProfit", "stopLoss", "guaranteedStop", "trailingStopPips", "exitLevels"] as const;
export type ProtectionFieldName = (typeof PROTECTION_FIELDS)[number];

/** Whether a request leaves every protection field it names at its current value. */
export function protectionUnchanged(current: Readonly<Brackets>, requested: Readonly<Brackets>): boolean {
  return PROTECTION_FIELDS.every(
    (field) => !Object.hasOwn(requested, field) || equalData(current[field], requested[field]),
  );
}

/**
 * The one validation for protection on a position or individual position: normalise to the instrument and policy,
 * check TP/SL sit on the right side of the price the position would close at, and check edit permissions.
 * Returns the normalised brackets.
 */
export function validatePositionProtection(
  position: Readonly<Position | IndividualPosition>,
  brackets: Brackets,
  instrument: InstrumentInfo,
  policy: CapabilityPolicy,
  quotes: TradingQuotes | undefined,
  maxLevels: number | undefined,
  individual: boolean,
): Brackets {
  const normalized = normalizeProtection(brackets, position.qty, instrument, policy, maxLevels);
  const directionError = protectionDirectionError(
    normalized,
    position.side,
    positionProtectionReference(position, quotes),
    "current price",
  );
  if (directionError) throw new TradingError("invalid-input", directionError);
  assertPositionProtectionPermissions(position, normalized, policy, individual);
  return normalized;
}
