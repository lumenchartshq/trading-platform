import { OrderType, StopType } from "../contracts/broker.js";
import type { Brackets, ExitLevel, Order } from "../contracts/broker.js";

/** Bracket fields that brokers represent as separate child orders. */
export type ProtectionField = "takeProfit" | "stopLoss" | "guaranteedStop" | "trailingStopPips";

/** The bracket field a broker child order represents: limit → take profit, stop → its stop style. */
export function childProtectionField(child: Pick<Order, "type" | "stopType">): ProtectionField | undefined {
  if (child.type === OrderType.Limit) return "takeProfit";
  if (child.type !== OrderType.Stop) return undefined;
  if (child.stopType === StopType.TrailingStop) return "trailingStopPips";
  if (child.stopType === StopType.GuaranteedStop) return "guaranteedStop";
  return "stopLoss";
}

/** Value of that field on the child: trailing distance, limit price for take profit, otherwise stop price. */
export function childProtectionValue(
  child: Pick<Order, "limitPrice" | "stopPrice" | "trailingStopPips">,
  field: ProtectionField,
): number | undefined {
  if (field === "trailingStopPips") return child.trailingStopPips;
  if (field === "takeProfit") return child.limitPrice;
  return child.stopPrice;
}

/** A child order the broker should report after protection is applied. */
export interface ExpectedProtectionLeg {
  readonly type: OrderType;
  /** Undefined for trailing stops, whose trigger price moves with the market. */
  readonly price?: number;
  /** Undefined for plain stop loss, which accepts any non-special stop type. */
  readonly stopType?: StopType;
  readonly levelId?: string;
  readonly qty: number;
}

/** Child orders implied by legacy brackets (one level of `qty`) or by allocated exit levels. */
export function expectedProtectionLegs(brackets: Readonly<Brackets>, qty: number): ExpectedProtectionLeg[] {
  const levels: readonly (Partial<ExitLevel> & Brackets & { qty: number })[] = brackets.exitLevels ?? [
    { id: undefined, qty, ...brackets },
  ];
  return levels.flatMap((level) => {
    const base = { levelId: level.id, qty: level.qty };
    const legs: ExpectedProtectionLeg[] = [];
    if (level.takeProfit !== undefined) legs.push({ ...base, type: OrderType.Limit, price: level.takeProfit });
    if (level.stopLoss !== undefined) legs.push({ ...base, type: OrderType.Stop, price: level.stopLoss });
    if (level.guaranteedStop !== undefined)
      legs.push({ ...base, type: OrderType.Stop, price: level.guaranteedStop, stopType: StopType.GuaranteedStop });
    if (level.trailingStopPips !== undefined)
      legs.push({ ...base, type: OrderType.Stop, stopType: StopType.TrailingStop });
    return legs;
  });
}

export function matchesProtectionLeg(child: Readonly<Order>, leg: ExpectedProtectionLeg): boolean {
  if (child.type !== leg.type || child.qty !== leg.qty) return false;
  if (leg.levelId !== undefined && !("exitLevelId" in child && child.exitLevelId === leg.levelId)) return false;
  if (leg.stopType !== undefined && child.stopType !== leg.stopType) return false;
  if (leg.price === undefined) return true;
  const price = leg.type === OrderType.Limit ? child.limitPrice : child.stopPrice;
  return price === leg.price;
}

/** Every expected leg has a matching live child, and there are no extra children. */
export function matchesProtectionLegs(
  children: readonly Readonly<Order>[],
  expected: readonly ExpectedProtectionLeg[],
): boolean {
  return (
    children.length === expected.length &&
    expected.every((leg) => children.some((child) => matchesProtectionLeg(child, leg)))
  );
}
