import { orderDisplayPrice, orderTypeName, sideName } from "./order-labels.js";
import { NotificationType, OrderStatus, OrderType, StopType } from "../contracts/broker.js";
import type { Order } from "../contracts/broker.js";
import type { EntityReader } from "./entity-store.js";
import { equalData } from "./immutable.js";
import { childProtectionField, type ProtectionField } from "./protection-legs.js";

export enum OrderNotice {
  Placed = "placed",
  Executed = "executed",
  PartialFill = "partially filled",
  Modified = "modified",
  Cancelled = "cancelled",
  Rejected = "rejected",
}

export interface OrderNotification {
  readonly title: string;
  readonly text: string;
  readonly type: NotificationType;
  readonly event: OrderNotice;
  readonly symbol: string;
  readonly orderId: string;
  readonly market: boolean;
  readonly trade?: { readonly side: Order["side"]; readonly quantity: number; readonly detail: string };
}
const protectionNames: Record<ProtectionField, string> = {
  takeProfit: "Take Profit",
  stopLoss: "Stop Loss",
  guaranteedStop: "Guaranteed Stop Loss",
  trailingStopPips: "Trailing Stop",
};
export function protectionNoticeName(order: Readonly<Order>): string | undefined {
  const field = "parentId" in order ? childProtectionField(order) : undefined;
  return field ? protectionNames[field] : undefined;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
const priceText = new Intl.NumberFormat("en", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 20 });
export function notificationPrice(value: number): string {
  return priceText.format(value);
}

export function describeOrderNotification(order: Readonly<Order>, event: OrderNotice, previous?: Readonly<Order>): OrderNotification {
  const fill = event === OrderNotice.Executed || event === OrderNotice.PartialFill;
  const quantity = fill && finite(order.filledQty) ? order.filledQty : order.qty;
  const price = fill ? order.avgPrice : orderDisplayPrice(order);
  let detail = finite(price) ? `at ${notificationPrice(price)}` : "";
  if (event === OrderNotice.PartialFill || (fill && (previous?.filledQty ?? 0) > 0)) {
    const average = finite(price) ? `at an average of ${notificationPrice(price)}` : "";
    detail = event === OrderNotice.PartialFill
      ? ["filled so far", average].filter(Boolean).join(" ")
      : average;
  }
  if (!fill && order.type === OrderType.StopLimit && finite(order.stopPrice) && finite(order.limitPrice))
    detail = `limit ${notificationPrice(order.limitPrice)} · stop ${notificationPrice(order.stopPrice)}`;
  if (!fill && order.stopType === StopType.TrailingStop && finite(order.trailingStopPips))
    detail = `${order.trailingStopPips} pips`;
  const orderName = protectionNoticeName(order) ?? orderTypeName(order.type);
  const reason = event === OrderNotice.Rejected ? order.message?.text : undefined;
  return {
    title: `${orderName ? `${orderName} order` : "Order"} ${event}`,
    text: reason || [`${sideName(order.side)} ${quantity}`, detail].filter(Boolean).join(" "),
    type: event === OrderNotice.Rejected ? NotificationType.Error : NotificationType.Success,
    event,
    symbol: order.symbol,
    orderId: order.id,
    market: order.type === OrderType.Market,
    ...(reason ? {} : { trade: { side: order.side, quantity, detail } }),
  };
}

const customValue = (order: Readonly<Order>, field: string) =>
  (order as unknown as Record<string, unknown>)[field] ??
  (order.extra as Record<string, unknown> | undefined)?.[field];

function changeEvent(next: Readonly<Order>, previous: Readonly<Order> | undefined, customFields: readonly string[]): OrderNotice | undefined {
  if (previous?.status !== next.status) {
    if (next.status === OrderStatus.Rejected) return OrderNotice.Rejected;
    if (next.status === OrderStatus.Filled) return OrderNotice.Executed;
    if (previous && next.status === OrderStatus.Canceled) return OrderNotice.Cancelled;
  }
  const active = next.status === OrderStatus.Working || next.status === OrderStatus.Inactive || next.status === OrderStatus.Placing;
  if (!active) return;
  if (finite(next.filledQty) && next.filledQty > (previous?.filledQty ?? 0))
    return OrderNotice.PartialFill;
  if (!previous) return OrderNotice.Placed;
  const trailing = next.stopType === StopType.TrailingStop && previous.stopType === StopType.TrailingStop;
  if (
    previous.type !== next.type ||
    previous.stopType !== next.stopType ||
    previous.limitPrice !== next.limitPrice ||
    (!trailing && previous.stopPrice !== next.stopPrice) ||
    previous.trailingStopPips !== next.trailingStopPips ||
    previous.qty !== next.qty ||
    customFields.some((field) => !equalData(customValue(previous, field), customValue(next, field)))
  ) return OrderNotice.Modified;
}

/** Snapshots refresh the baseline silently. Live notices report broker transitions and confirmed edits. */
export function watchOrderNotifications(
  orders: EntityReader<Order>,
  live: () => boolean,
  customFields: readonly string[],
  push: (notification: OrderNotification, order: Readonly<Order>) => void,
): () => void {
  const known = new Map<string, Readonly<Order>>();
  for (const id of orders.ids()) known.set(id, orders.get(id)!);
  return orders.subscribeChanges((change) => {
    const notify = live();
    for (const id of change.removed) known.delete(id);
    for (const id of [...change.added, ...change.updated]) {
      const next = orders.get(id);
      if (!next) continue;
      const previous = known.get(id);
      known.set(id, next);
      if (!notify) continue;
      const event = changeEvent(next, previous, customFields);
      if (event) push(describeOrderNotification(next, event, previous), next);
    }
  });
}
