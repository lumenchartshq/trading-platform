import type { IDelegate } from '../contracts/broker.js';
interface Subscription<T extends Function> {
  readonly owner: object | null;
  readonly callback: T;
  readonly once: boolean;
}
/** Matches subscriptions by both receiver and function; fires a stable subscription snapshot. */
export class Delegate<T extends Function> implements IDelegate<T> {
  private readonly listeners = new Set<Subscription<T>>();
  private disposed = false;
  readonly fire = ((...args: unknown[]) => {
    if (this.disposed) return;
    let failure: unknown;
    let failed = false;
    for (const entry of [...this.listeners]) {
      if (!this.listeners.has(entry)) continue;
      if (entry.once) this.listeners.delete(entry);
      try { Reflect.apply(entry.callback, entry.owner, args); }
      catch (cause) { if (!failed) failure = cause; failed = true; }
    }
    if (failed) throw failure;
  }) as unknown as T;
  subscribe(owner: object | null, callback: T, singleshot = false): void {
    if (this.disposed) return;
    this.unsubscribe(owner, callback);
    this.listeners.add({ owner, callback, once: singleshot });
  }
  unsubscribe(owner: object | null, callback: T): void {
    for (const entry of this.listeners) if (entry.owner === owner && entry.callback === callback) this.listeners.delete(entry);
  }
  unsubscribeAll(owner: object | null): void {
    for (const entry of this.listeners) if (entry.owner === owner) this.listeners.delete(entry);
  }
  destroy(): void { this.disposed = true; this.listeners.clear(); }
}
