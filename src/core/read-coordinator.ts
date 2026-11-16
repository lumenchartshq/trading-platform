import type { TradingClock } from "../contracts/ports.js";
import { TradingError } from "./errors.js";

/** Owns account-scoped reads, including providers that never settle. */
export class ReadCoordinator {
  private alive = true;
  private readonly pending = new Set<(error: TradingError) => void>();

  constructor(
    private readonly clock: TradingClock,
    private readonly generation: () => number,
    private readonly deadline = 15000,
  ) {}

  read<T>(load: () => T | Promise<T>, epoch = this.generation()): Promise<T> {
    if (!this.alive) return Promise.reject(this.closed());
    if (epoch !== this.generation()) return Promise.reject(this.stale());

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (accept: () => void) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        this.pending.delete(cancel);
        accept();
      };
      const cancel = (error: TradingError) => finish(() => reject(error));
      const timer = this.clock.setTimeout(
        () =>
          cancel(
            new TradingError(
              "broker-unavailable",
              "Account information took too long to load.",
            ),
          ),
        this.deadline,
      );
      this.pending.add(cancel);
      try {
        // Invoke synchronously so broker push ordering remains unchanged.
        Promise.resolve(load()).then(
          (value) =>
            finish(() => {
              if (epoch !== this.generation()) reject(this.stale());
              else resolve(value);
            }),
          (cause) => finish(() => reject(cause)),
        );
      } catch (cause) {
        finish(() => reject(cause));
      }
    });
  }

  invalidate(): void {
    for (const cancel of this.pending) cancel(this.stale());
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const cancel of this.pending) cancel(this.closed());
  }

  private stale(): TradingError {
    return TradingError.accountChanged();
  }

  private closed(): TradingError {
    return TradingError.disposed();
  }
}
