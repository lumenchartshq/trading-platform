import type { SymbolType } from '../contracts/broker.js';

/** The prices the paper broker fills against. Any quote shape with these fields works. */
export interface PaperQuote {
  readonly bid?: number;
  readonly ask?: number;
  /** When `bid` and `ask` became tradable, in milliseconds since the epoch. Missing means not tradable. */
  readonly executableAt?: number;
}

/** What the paper broker needs to know about a symbol it trades. */
export interface PaperInstrument {
  /** The symbol shown in the order ticket. */
  readonly symbol: string;
  readonly description: string;
  readonly type: SymbolType;
  /** The quote currency: profit, loss and the account are in this currency. */
  readonly currency: string;
  readonly baseCurrency?: string;
  /** The price increment. Order and protection prices must be multiples of it. */
  readonly tick: number;
  /** The quantity increment, which is also the smallest quantity. */
  readonly quantityStep: number;
  readonly defaultQuantity: number;
}

/** Whether a symbol can be traded on paper, and why not when it cannot. */
export type PaperInstrumentLookup =
  | { readonly tradable: true; readonly instrument: PaperInstrument }
  | { readonly tradable: false; readonly reason: string };

/**
 * The host's prices and symbols, as the paper broker reads them. It keeps no
 * market state of its own: fills always use the host's latest quote.
 */
export interface PaperMarket {
  instrument(symbol: string): PaperInstrumentLookup;
  quote(symbol: string): PaperQuote | undefined;
  /** Calls `listener` with a symbol whenever its quote changes. Returns the unsubscribe function. */
  onQuote(listener: (symbol: string) => void): () => void;
  /**
   * Optional: keep quotes flowing for `symbol` while the broker has working
   * orders or a position in it. Returns the release function.
   */
  demand?(symbol: string): () => void;
}

/**
 * Coalesces account updates (P&L and equity), which can be expensive to redraw
 * on every quote. `request` asks for one update soon; `cancel` drops a pending one.
 */
export interface PaperFinanceSchedule {
  request(): void;
  cancel(): void;
  dispose(): void;
}

/** One account update at most every `intervalMs`, using timers. */
export function intervalFinanceSchedule(flush: () => void, intervalMs = 250): PaperFinanceSchedule {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    request() {
      timer ??= setTimeout(() => {
        timer = undefined;
        flush();
      }, intervalMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      this.cancel();
    },
  };
}
