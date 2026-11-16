export class ManualClock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, milliseconds) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + milliseconds, callback }); return id; };
  clearTimeout = id => { this.timers.delete(id); };
  advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = target;
  }
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
