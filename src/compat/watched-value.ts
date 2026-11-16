import type { IWatchedValue, WatchedValueCallback, WatchedValueSubscribeOptions } from '../contracts/broker.js';
interface Listener<T> { readonly callback: WatchedValueCallback<T>; readonly once: boolean; readonly truthy: boolean; }
export class WatchedValue<T> implements IWatchedValue<T> {
  private current: T;
  private available: boolean;
  private disposed = false;
  private readonly listeners = new Set<Listener<T>>();
  /** With `failed`, listener failures are reported there instead of thrown at the writer (host-facing values). */
  constructor(
    value?: T,
    private readonly accepts: (value: T) => boolean = () => true,
    private readonly failed?: (cause: unknown) => void,
  ) {
    this.current = value as T;
    this.available = arguments.length > 0 && value !== undefined;
  }
  value(): T { return this.current; }
  setValue(value: T, forceUpdate = false): void {
    const failure = this.trySetValue(value, forceUpdate);
    if (!failure) return;
    if (this.failed) this.failed(failure.cause);
    else throw failure.cause;
  }
  /**
   * Platform-internal write that returns a listener failure instead of reporting or throwing it, so the
   * platform's own controls (the Trading settings page) can tell the user a save failed.
   */
  trySetValue(value: T, forceUpdate = false): { readonly cause: unknown } | undefined {
    if (this.disposed || !this.accepts(value)) return undefined;
    if (this.available && Object.is(this.current, value) && !forceUpdate) return undefined;
    this.current = value;
    this.available = true;
    let failure: unknown;
    let failed = false;
    for (const entry of [...this.listeners]) {
      if (!this.listeners.has(entry) || (entry.truthy && value !== true)) continue;
      if (entry.once) this.listeners.delete(entry);
      try { entry.callback(value); } catch (cause) { if (!failed) failure = cause; failed = true; }
    }
    return failed ? { cause: failure } : undefined;
  }
  subscribe(callback: WatchedValueCallback<T>, options: WatchedValueSubscribeOptions = {}): void {
    this.add(callback, !!options.once, !!options.callWithLast, false);
  }
  private add(callback: WatchedValueCallback<T>, once: boolean, callWithLast: boolean, truthy: boolean): void {
    if (this.disposed) return;
    this.unsubscribe(callback);
    const entry = { callback, once, truthy };
    this.listeners.add(entry);
    if (!callWithLast || !this.available || (truthy && this.current !== true)) return;
    if (once) this.listeners.delete(entry);
    callback(this.current);
  }
  unsubscribe(callback?: WatchedValueCallback<T> | null): void {
    if (callback == null) { this.listeners.clear(); return; }
    for (const entry of this.listeners) if (entry.callback === callback) this.listeners.delete(entry);
  }
  when(callback: WatchedValueCallback<T>): void { this.add(callback, true, true, true); }
  destroy(): void { this.disposed = true; this.listeners.clear(); }
}
