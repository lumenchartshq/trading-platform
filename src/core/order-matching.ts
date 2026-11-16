import { StopType } from "../contracts/broker.js";
import type { InstrumentInfo, Order, PreOrder } from "../contracts/broker.js";
import { equalData } from "./immutable.js";
import { editableOrderFields } from "./order-modification.js";
import { effectiveTick } from "./trading-rules.js";

const priceFields: ReadonlySet<string> = new Set([
  "limitPrice",
  "stopPrice",
  "stopLoss",
  "takeProfit",
  "guaranteedStop",
]);
type MatchInstrument = Pick<InstrumentInfo, "minTick" | "variableMinTick"> & {
  readonly qty?: Pick<InstrumentInfo["qty"], "step">;
};

/** Values equal within half a step; brokers echo tick-rounded prices and normalised lots. */
function nearlyEqual(a: unknown, b: unknown, step: number | undefined): boolean {
  if (equalData(a, b)) return true;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (!step || !(step > 0)) return false;
  return Math.abs(a - b) <= step / 2 + Number.EPSILON * Math.max(Math.abs(a), Math.abs(b), 1);
}
function priceStep(price: unknown, instrument: MatchInstrument | undefined): number | undefined {
  if (!instrument || typeof price !== "number" || !Number.isFinite(price)) return undefined;
  try {
    return effectiveTick(price, instrument);
  } catch {
    return undefined;
  }
}
/**
 * Whether a broker order reflects the submitted fields: prices within half a tick and quantity within half a
 * quantity step of the instrument; every other submitted field exactly. Used for uncorrelated candidates and
 * modifications.
 */
export function matchesOrder(
  order: Readonly<Order>,
  submitted: PreOrder | Order,
  instrument?: MatchInstrument,
): boolean {
  if (order.symbol !== submitted.symbol) return false;
  // A trailing stop's price is broker-owned and may advance while its distance edit is acknowledged.
  const trailing = order.stopType === StopType.TrailingStop && submitted.stopType === StopType.TrailingStop;
  return editableOrderFields.every((field) => {
    if (!Object.hasOwn(submitted, field)) return true;
    if (trailing && field === "stopPrice") return true;
    const expected = submitted[field as keyof typeof submitted];
    const actual = order[field];
    if (priceFields.has(field)) return nearlyEqual(actual, expected, priceStep(expected, instrument));
    if (field === "qty") return nearlyEqual(actual, expected, instrument?.qty?.step);
    return equalData(actual, expected);
  });
}
/**
 * The broker returned this order's ID: identity plus symbol, side and type confirm it. Brokers may round,
 * normalise or drop other fields (custom fields, for example) in their echo.
 */
export function matchesIdentifiedOrder(order: Readonly<Order>, submitted: PreOrder | Order): boolean {
  return order.symbol === submitted.symbol && order.side === submitted.side && order.type === submitted.type;
}
