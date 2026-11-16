import type { NotificationType } from "../contracts/broker.js";
import type { ReadonlyValue } from "../contracts/ports.js";
import type { OrderNotification } from "./order-notifications.js";
import { ValueStore } from "./value-store.js";

export interface TradingNotification {
  readonly id: number;
  readonly time: number;
  readonly title: string;
  readonly text: string;
  readonly type: NotificationType;
  readonly symbol?: string;
  readonly orderId?: string;
  readonly accountGeneration?: number;
  readonly event?: OrderNotification["event"];
  readonly market?: boolean;
  readonly trade?: OrderNotification["trade"];
  readonly audience?: "history" | "toast";
}

export type NotificationInput = Omit<TradingNotification, "id" | "time"> & { readonly time?: number };

/** One bounded history for broker messages and authoritative order transitions. */
export class NotificationLog implements ReadonlyValue<readonly TradingNotification[]> {
  private readonly entries = new ValueStore<readonly TradingNotification[]>([]);
  private sequence = 0;
  private disposed = false;

  constructor(private readonly now = Date.now) {}

  get(): readonly TradingNotification[] { return this.entries.get(); }

  subscribe(listener: (entries: readonly TradingNotification[]) => void): () => void {
    return this.entries.subscribe(listener);
  }

  push(notification: NotificationInput): void {
    this.pushBatch([notification]);
  }

  pushBatch(notifications: readonly NotificationInput[]): void {
    if (this.disposed || !notifications.length) return;
    const added = notifications.map(item => ({ ...item, time: item.time ?? this.now(), id: ++this.sequence }));
    const entries = [...this.entries.get(), ...added];
    const history = entries.filter(item => item.audience !== "toast").slice(-200);
    // Bound toast-only summaries independently so they do not consume history slots.
    const toasts = entries.filter(item => item.audience === "toast").slice(-200);
    this.entries.set([...history, ...toasts].sort((a, b) => a.id - b.id));
  }

  destroy(): void {
    this.disposed = true;
    this.entries.destroy();
  }
}
