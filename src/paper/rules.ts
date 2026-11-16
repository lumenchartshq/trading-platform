import { OrderType, Side } from '../contracts/broker.js';
import type { PaperQuote } from './market.js';

/** The reason codes the chart understands; see `BrokerRejection`. */
export type PaperRejectionCode = 'rejected' | 'unavailable' | 'invalid' | 'unsupported';

/**
 * An error the chart shows to the user: it carries the `BrokerRejection` shape
 * (`code` and a user-safe `message`). A plain Error shows generic wording instead.
 */
export class PaperRejection extends Error {
  readonly code: PaperRejectionCode;
  constructor(code: PaperRejectionCode, message: string) {
    super(message);
    this.name = 'PaperRejection';
    this.code = code;
  }
}

/** How long a quote stays tradable after `executableAt`. */
export const defaultQuoteMaxAgeMs = 15_000;

/** The price a market order on `side` fills at: the ask to buy, the bid to sell. Throws without a fresh quote. */
export function executableQuote(
  quote: PaperQuote | undefined,
  side: Side,
  now = Date.now(),
  maxAgeMs = defaultQuoteMaxAgeMs,
): number {
  if (!quote || !quote.executableAt || now - quote.executableAt > maxAgeMs || now < quote.executableAt)
    throw new PaperRejection('unavailable', 'A fresh bid and ask are needed to trade.');
  const price = side === Side.Buy ? quote.ask : quote.bid;
  if (!price || !Number.isFinite(price)) throw new PaperRejection('unavailable', 'An executable quote is unavailable.');
  return price;
}

/** Whether an order of `type` on `side` fills at `price`. */
export function shouldFill(type: OrderType, side: Side, price: number, limit?: number, stop?: number) {
  if (type === OrderType.Market) return true;
  if (type === OrderType.Limit) return limit !== undefined && (side === Side.Buy ? price <= limit : price >= limit);
  if (type === OrderType.Stop) return stop !== undefined && (side === Side.Buy ? price >= stop : price <= stop);
  return false;
}

/** A positive quantity on the instrument's step, up to one million. */
export function validQuantity(item: { readonly quantityStep: number }, quantity: number) {
  return (
    Number.isFinite(quantity) &&
    quantity > 0 &&
    quantity <= 1_000_000 &&
    Math.abs(quantity / item.quantityStep - Math.round(quantity / item.quantityStep)) < 1e-6
  );
}

/** A net position after a fill: same side adds and averages, the other side reduces, closes or reverses. */
export function netFill(
  previous: { side: Side; qty: number; avgPrice: number } | undefined,
  side: Side,
  quantity: number,
  price: number,
) {
  if (!previous) return { side, qty: quantity, avgPrice: price, realized: 0 };
  if (previous.side === side)
    return {
      side,
      qty: previous.qty + quantity,
      avgPrice: (previous.qty * previous.avgPrice + quantity * price) / (previous.qty + quantity),
      realized: 0,
    };
  const closed = Math.min(previous.qty, quantity),
    remaining = previous.qty - quantity;
  return {
    side: remaining < 0 ? side : previous.side,
    qty: Math.abs(remaining),
    avgPrice: remaining < 0 ? price : previous.avgPrice,
    realized: (price - previous.avgPrice) * closed * previous.side,
  };
}

/** Take profit must be beyond `reference` in the position's favour, and stop loss behind it. */
export function validateProtection(side: Side, reference: number, brackets: { takeProfit?: number; stopLoss?: number }) {
  if (brackets.takeProfit !== undefined && (brackets.takeProfit - reference) * side <= 0)
    throw new PaperRejection('invalid', 'Take profit must be beyond the reference price.');
  if (brackets.stopLoss !== undefined && (brackets.stopLoss - reference) * side >= 0)
    throw new PaperRejection('invalid', 'Stop loss must be behind the reference price.');
}

/** A positive price on the instrument's tick. */
export function onTick(price: number, tick: number) {
  return Number.isFinite(price) && price > 0 && Math.abs(price / tick - Math.round(price / tick)) <= 1e-5;
}
