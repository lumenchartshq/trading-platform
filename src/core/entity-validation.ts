import { OrderStatus, OrderType, Side } from '../contracts/broker.js';
import type { Execution, IndividualPosition, Order, Position } from '../contracts/broker.js';
import { TradingError } from './errors.js';
export const terminalStatuses = new Set([OrderStatus.Canceled, OrderStatus.Filled, OrderStatus.Rejected]);
export function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TradingError('invalid-input', `Invalid ${name}.`);
}
function identity(entity: { id: string; symbol: string; side: Side; qty: number }): void {
  if (typeof entity.id !== 'string' || !entity.id || typeof entity.symbol !== 'string' || !entity.symbol) throw new TradingError('invalid-input', 'Missing trading identity.');
  if (entity.side !== Side.Buy && entity.side !== Side.Sell) throw new TradingError('invalid-input', 'Invalid trade side.');
  finite(entity.qty, 'quantity');
  if (entity.qty < 0) throw new TradingError('invalid-input', 'Invalid quantity.');
}
export function validateOrder(entity: Order): void {
  identity(entity);
  if (![OrderType.Market, OrderType.Limit, OrderType.Stop, OrderType.StopLimit].includes(entity.type)) throw new TradingError('invalid-input', 'Invalid order type.');
  if (![OrderStatus.Canceled, OrderStatus.Filled, OrderStatus.Inactive, OrderStatus.Placing, OrderStatus.Rejected, OrderStatus.Working].includes(entity.status)) throw new TradingError('invalid-input', 'Invalid order status.');
  for (const field of ['limitPrice', 'stopPrice', 'takeProfit', 'stopLoss', 'filledQty', 'avgPrice'] as const) if (entity[field] !== undefined) finite(entity[field], field);
}
export function acceptOrder(next: Order, old?: Readonly<Order>): boolean {
  // Arrival order is authoritative except known terminal regressions; refresh can replace identities.
  return !old || !terminalStatuses.has(old.status) || next.status === old.status;
}
export function validatePosition(entity: Position): void { identity(entity); finite(entity.avgPrice, 'position price'); }
export function validateIndividualPosition(entity: IndividualPosition): void { identity(entity); finite(entity.price, 'position price'); finite(entity.date, 'position date'); }
export function validateExecution(entity: Execution): void { identity(entity); finite(entity.price, 'execution price'); finite(entity.time, 'execution time'); }
