import type { Dispose, ReadonlyValue } from '../contracts/ports.js';
import { equalData, snapshot } from './immutable.js';
export class ValueStore<T> implements ReadonlyValue<Readonly<T>> {
  private current: Readonly<T>;
  private disposed = false;
  private readonly listeners = new Set<(value: Readonly<T>) => void>();
  constructor(value: T) { this.current = snapshot(value); }
  get(): Readonly<T> { return this.current; }
  set(value: T): void {
    if (this.disposed || equalData(this.current, value)) return;
    this.current = snapshot(value);
    for (const listener of [...this.listeners]) {
      if (this.disposed) break;
      if (this.listeners.has(listener)) listener(this.current);
    }
  }
  subscribe(listener: (value: Readonly<T>) => void): Dispose {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  destroy(): void { this.disposed = true; this.listeners.clear(); }
}
