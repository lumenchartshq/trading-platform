import { OrderType, Side } from "../contracts/broker.js";
import type { PreOrder } from "../contracts/broker.js";

const orderTypeNames: Record<OrderType, string> = {
  [OrderType.Market]: "Market",
  [OrderType.Limit]: "Limit",
  [OrderType.Stop]: "Stop",
  [OrderType.StopLimit]: "Stop-limit",
};
/** User-facing order type wording shared by the ticket, chart lines, dialogs and notifications. */
export function orderTypeName(type: OrderType): string {
  return orderTypeNames[type] ?? "";
}
export function sideName(side: Side): "Buy" | "Sell" {
  return side === Side.Buy ? "Buy" : "Sell";
}
/** Price shown next to an order: the limit price for limit and stop-limit orders, otherwise the stop price. */
export function orderDisplayPrice(order: Pick<PreOrder, "type" | "limitPrice" | "stopPrice">): number | undefined {
  return order.type === OrderType.Limit || order.type === OrderType.StopLimit ? order.limitPrice : order.stopPrice;
}
