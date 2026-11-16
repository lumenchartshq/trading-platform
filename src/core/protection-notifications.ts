import { NotificationType } from "../contracts/broker.js";
import type { Order, ParentType } from "../contracts/broker.js";
import type { AccountContext } from "./command-context.js";
import type { NotificationInput, NotificationLog } from "./notification-log.js";
import { describeOrderNotification, OrderNotice, protectionNoticeName, type OrderNotification } from "./order-notifications.js";
import { childProtectionField, childProtectionValue, type ProtectionField } from "./protection-legs.js";

type RecordedNotice = OrderNotification & { readonly time: number; readonly accountGeneration?: number };

function protectionByLeg(orders: readonly Readonly<Order>[]) {
  const legs = new Map<string, { order: Readonly<Order>; field: ProtectionField }>();
  for (const order of orders) {
    const field = childProtectionField(order);
    if (!field || !("parentId" in order)) return;
    const key = JSON.stringify([field, order.exitLevelId]);
    if (legs.has(key)) return; // Without a unique leg identity, report the broker events as delivered.
    legs.set(key, { order, field });
  }
  return legs;
}

function replacementSummary(
  previous: readonly Readonly<Order>[],
  confirmed: readonly Readonly<Order>[],
  notices: readonly RecordedNotice[],
): NotificationInput | undefined {
  const before = protectionByLeg(previous), after = protectionByLeg(confirmed);
  if (!before || !after) return;
  const placed = new Set(notices.filter(item => item.event === OrderNotice.Placed).map(item => item.orderId));
  const cancelled = new Set(notices.filter(item => item.event === OrderNotice.Cancelled).map(item => item.orderId));
  const replaced = [...before].some(([key, { order: old }]) => {
    const next = after.get(key)?.order;
    return next && next.id !== old.id && placed.has(next.id) && cancelled.has(old.id);
  });
  if (!replaced) return;

  const edits: { order: Readonly<Order>; event: OrderNotice }[] = [];
  for (const [key, { order, field }] of after) {
    const old = before.get(key)?.order;
    if (old && old.side === order.side && old.qty === order.qty &&
      childProtectionValue(old, field) === childProtectionValue(order, field)) continue;
    edits.push({ order, event: old ? OrderNotice.Modified : OrderNotice.Placed });
  }
  for (const [key, { order }] of before)
    if (!after.has(key)) edits.push({ order, event: OrderNotice.Cancelled });
  if (!edits.length) return;
  const descriptions = edits.map(({ order, event }) => describeOrderNotification(order, event));
  if (descriptions.length === 1) return { ...descriptions[0], audience: "toast" };

  const details = edits.map(({ order, event }, index) => {
    const leg = protectionNoticeName(order);
    return event === OrderNotice.Cancelled ? `${leg} removed` : `${leg} · ${descriptions[index].text}`;
  });
  return {
    title: "Protection updated",
    symbol: edits[0].order.symbol,
    text: details.join("\n"),
    type: NotificationType.Success,
    audience: "toast",
  };
}

/** Correlate cancel/replace noise only with a dispatched position protection command. */
export function createProtectionNotifications(
  log: NotificationLog,
  now: () => number,
  current: () => AccountContext | undefined,
  live: () => boolean,
) {
  const pending = new Map<string, RecordedNotice[]>();
  const key = (context: AccountContext, parentType: ParentType, id: string) =>
    JSON.stringify([context.accountId, context.generation, parentType, id]);
  return {
    order(notice: OrderNotification, order: Readonly<Order>) {
      const context = current();
      const entry = { ...notice, time: now(), accountGeneration: context?.generation };
      if (context && "parentId" in order && childProtectionField(order) &&
        (notice.event === OrderNotice.Placed || notice.event === OrderNotice.Cancelled || notice.event === OrderNotice.Modified)) {
        const notices = pending.get(key(context, order.parentType, order.parentId));
        if (notices && notices.length < 200) {
          notices.push(entry);
          return;
        }
      }
      log.push(entry);
    },
    begin(context: AccountContext, parentType: ParentType, id: string, previous: readonly Readonly<Order>[]) {
      const identity = key(context, parentType, id);
      const notices: RecordedNotice[] = [];
      pending.set(identity, notices);
      return (confirmed: readonly Readonly<Order>[] | undefined) => {
        if (pending.get(identity) === notices) pending.delete(identity);
        const active = current();
        const canToast = !!active && key(active, parentType, id) === identity && live();
        const summary = confirmed && canToast ? replacementSummary(previous, confirmed, notices) : undefined;
        const batch: NotificationInput[] = notices.map(notice => ({
          ...notice,
          ...(!canToast || summary ? { audience: "history" } : {}),
        }));
        if (summary) batch.push(summary);
        log.pushBatch(batch);
      };
    },
  };
}
