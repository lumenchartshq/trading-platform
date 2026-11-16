import type {
  Brackets,
  IndividualPosition,
  Position,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { TradingError } from "./errors.js";
import { equalData } from "./immutable.js";

function trailingLevels(levels: Brackets["exitLevels"]) {
  return (levels ?? [])
    .filter((level) => level.trailingStopPips !== undefined)
    .map(({ id, qty, trailingStopPips }) => ({ id, qty, trailingStopPips }))
    .sort((left, right) => {
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
}
/** The public command boundary owns permissions even when the built-in dialog is bypassed. */
export function assertPositionProtectionPermissions(
  previous: Readonly<Position | IndividualPosition>,
  brackets: Readonly<Brackets>,
  policy: CapabilityPolicy,
  individual: boolean,
): void {
  const supported = individual
    ? policy.flags.supportIndividualPositionBrackets
    : policy.flags.supportPositionBrackets;
  if (!supported || policy.symbol.supportModifyPositionBrackets === false)
    throw new TradingError("unsupported", "Protection editing is unavailable.");
  if (policy.flags.supportModifyTrailingStop) return;
  const changedDistance =
    Object.hasOwn(brackets, "trailingStopPips") &&
    !equalData(previous.trailingStopPips, brackets.trailingStopPips);
  const changedLevels =
    Object.hasOwn(brackets, "exitLevels") &&
    !equalData(
      trailingLevels(previous.exitLevels),
      trailingLevels(brackets.exitLevels),
    );
  if (changedDistance || changedLevels)
    throw new TradingError(
      "unsupported",
      "Trailing stop protection cannot be changed.",
    );
}
