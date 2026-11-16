import { childProtectionField, childProtectionValue, type ProtectionField } from "./protection-legs.js";
import { OrderType, StopType } from "../contracts/broker.js";
import type {
  Brackets,
  Order,
  InstrumentInfo,
} from "../contracts/broker.js";
import { equalData } from "./immutable.js";
import { aligned, effectiveTick, validateQuantity } from "./trading-rules.js";
import { TradingError } from "./errors.js";

/** Conditional child prices are checked against their protection context, not entry-order market direction. */
const missingValueMessages: Record<ProtectionField, string> = {
  takeProfit: "Enter a take profit price.",
  stopLoss: "Enter a stop price.",
  guaranteedStop: "Enter a stop price.",
  trailingStopPips: "Enter a trailing distance.",
};
export function validateBracketEditInput(
  order: Readonly<Order>,
  instrument: InstrumentInfo,
): void {
  validateQuantity(order.qty, instrument.qty);
  if (order.type !== OrderType.Limit && order.type !== OrderType.Stop)
    throw new TradingError(
      "unsupported",
      "This protection order type cannot be edited.",
    );
  if (
    order.type === OrderType.Stop &&
    order.stopType === StopType.TrailingStop
  ) {
    if (
      order.trailingStopPips === undefined ||
      !Number.isFinite(order.trailingStopPips) ||
      order.trailingStopPips <= 0
    )
      throw new TradingError(
        "invalid-input",
        "Enter a positive trailing distance.",
      );
    // The live trailing price is broker-owned and need not sit on the tick grid.
    return;
  }
  const price =
    order.type === OrderType.Limit ? order.limitPrice : order.stopPrice;
  const step =
    order.type === OrderType.Limit
      ? instrument.limitPriceStep
      : instrument.stopPriceStep;
  if (
    price === undefined ||
    !Number.isFinite(price) ||
    !aligned(price, step ?? effectiveTick(price, instrument))
  )
    throw new TradingError(
      "invalid-input",
      "Enter a protection price aligned to the instrument step.",
    );
  if (
    order.stopType !== undefined &&
    ![
      StopType.StopLoss,
      StopType.GuaranteedStop,
      StopType.TrailingStop,
    ].includes(order.stopType)
  )
    throw new TradingError("invalid-input", "Choose a supported stop style.");
}

/** Translate one called child's financial edit without replacing its siblings or parent quantity. */
export function protectionFromChildEdit(
  parent: Readonly<Brackets & { qty: number }>,
  previous: Readonly<Order>,
  changed: Readonly<Order>,
): Brackets {
  if (
    !("parentId" in previous) ||
    !("parentId" in changed) ||
    previous.id !== changed.id ||
    previous.symbol !== changed.symbol ||
    previous.parentId !== changed.parentId ||
    previous.parentType !== changed.parentType ||
    previous.exitLevelId !== changed.exitLevelId ||
    previous.side !== changed.side ||
    previous.type !== changed.type
  )
    throw new TradingError(
      "invalid-input",
      "The protection order identity cannot be changed.",
    );
  const fixedFields = [
    "duration",
    "customFields",
    "exitLevels",
    "takeProfit",
    "stopLoss",
    "guaranteedStop",
  ] as const;
  for (const field of fixedFields)
    if (!equalData(previous[field], changed[field]))
      throw new TradingError(
        "unsupported",
        "Only the protection price, style and allocated quantity can be changed here.",
      );
  const otherPrice =
    changed.type === OrderType.Limit ? "stopPrice" : "limitPrice";
  if (
    !equalData(previous[otherPrice], changed[otherPrice]) ||
    (changed.type === OrderType.Limit &&
      (!equalData(previous.stopType, changed.stopType) ||
        !equalData(previous.trailingStopPips, changed.trailingStopPips)))
  )
    throw new TradingError(
      "invalid-input",
      "The protection order type cannot be changed.",
    );
  const levels = parent.exitLevels;
  const level = levels?.length
    ? levels.find((value) => value.id === previous.exitLevelId)
    : parent;
  if (!level)
    throw new TradingError(
      "stale-context",
      "This protection level is no longer available.",
    );
  if (!levels?.length && changed.qty !== parent.qty)
    throw new TradingError(
      "invalid-input",
      "Change the parent quantity or use allocated exit levels.",
    );
  const field = childProtectionField(changed);
  if (!field)
    throw new TradingError(
      "unsupported",
      "This protection order type cannot be edited.",
    );
  if (field === "trailingStopPips" && changed.stopPrice !== previous.stopPrice)
    throw new TradingError(
      "invalid-input",
      "Change the trailing distance to update this protection.",
    );
  const value = childProtectionValue(changed, field);
  if (value === undefined) throw new TradingError("invalid-input", missingValueMessages[field]);
  // A stop child carries exactly one stop style; editing it replaces the others.
  const patch: Brackets =
    field === "takeProfit"
      ? { takeProfit: value }
      : { stopLoss: undefined, guaranteedStop: undefined, trailingStopPips: undefined, [field]: value };
  if (levels?.length)
    return {
      exitLevels: levels.map((value) =>
        value.id === previous.exitLevelId
          ? { ...structuredClone(value), ...patch, qty: changed.qty }
          : structuredClone(value),
      ),
      takeProfit: undefined,
      stopLoss: undefined,
      guaranteedStop: undefined,
      trailingStopPips: undefined,
    };
  return {
    takeProfit: parent.takeProfit,
    stopLoss: parent.stopLoss,
    guaranteedStop: parent.guaranteedStop,
    trailingStopPips: parent.trailingStopPips,
    ...patch,
    exitLevels: undefined,
  };
}
