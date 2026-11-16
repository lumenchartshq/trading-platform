import { OrderType, StopType } from "../contracts/broker.js";
import type {
  BracketOrder,
  Brackets,
} from "../contracts/broker.js";

type ProtectionLeg =
  "takeProfit" | "stopLoss" | "guaranteedStop" | "trailingStopPips";
const protectionLegs: readonly ProtectionLeg[] = [
  "takeProfit",
  "stopLoss",
  "guaranteedStop",
  "trailingStopPips",
];
function leg(order: BracketOrder): ProtectionLeg {
  if (order.type === OrderType.Limit) return "takeProfit";
  if (order.stopType === StopType.TrailingStop) return "trailingStopPips";
  if (order.stopType === StopType.GuaranteedStop) return "guaranteedStop";
  return "stopLoss";
}
/** Broker-owned protection metadata follows canceled child orders without reallocating surviving levels. */
export function withoutCanceledProtection<
  T extends Brackets & { stopType?: StopType; trailingStopPrice?: number },
>(parent: T, canceled: readonly BracketOrder[]): T {
  const next = { ...parent };
  if (parent.exitLevels?.length) {
    next.exitLevels = parent.exitLevels.flatMap((level) => {
      const removed = canceled.filter(
        (child) => child.exitLevelId === level.id,
      );
      if (!removed.length) return [level];
      const updated = { ...level };
      for (const child of removed) delete updated[leg(child)];
      return protectionLegs.some((key) => updated[key] !== undefined)
        ? [updated]
        : [];
    });
    if (!next.exitLevels.length) delete next.exitLevels;
    return next;
  }
  for (const child of canceled) delete next[leg(child)];
  if (next.trailingStopPips === undefined) delete next.trailingStopPrice;
  if (
    next.stopLoss === undefined &&
    next.trailingStopPips === undefined &&
    next.guaranteedStop === undefined
  )
    delete next.stopType;
  return next;
}
