import type { TradingClock } from '../contracts/ports.js';
/** Deterministic fixture clock: no wall time or background market activity. */
export class SimulationClock implements TradingClock {
  private time: number;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  constructor(start = 1700000000000) { this.time = start; }
  now(): number { return this.time; }
  setTimeout(callback: () => void, milliseconds: number): number {
    const id = ++this.sequence; this.timers.set(id, { at: this.time + milliseconds, callback }); return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Advance requires a nonnegative duration.');
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = target;
  }
}
