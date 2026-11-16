import { KeyedRefCount, releaseAll } from "../core/keyed-ref-count.js";
import type {
  DOMData,
  IBrokerTerminal,
  InstrumentInfo,
  TradingQuotes,
} from "../contracts/broker.js";
import type {
  Dispose,
  TradingMarketDataPort,
  TradingQuoteSnapshot,
} from "../contracts/ports.js";
import type { TradingState } from "../core/trading-state.js";
import { snapshot } from "../core/immutable.js";
import { TradingError } from "../core/errors.js";
import { DepthBook } from "./depth-book.js";
import { normalizeQuotes } from "./subscriptions.js";
interface QuoteConsumer {
  readonly speed: "fast" | "normal";
  readonly listener: (value: TradingQuoteSnapshot) => void;
}
/** One provider lease per symbol; every consumer receives the same normalized snapshot. */
interface QuoteDemand {
  readonly consumers: Map<symbol, QuoteConsumer>;
  release?: Dispose;
  speed?: "fast" | "normal";
}
interface BookDemand {
  readonly listeners: Map<symbol, (data: Readonly<DOMData>) => void>;
  readonly buffered: DOMData[];
  book?: DepthBook;
  release?: Dispose;
  starting?: boolean;
}
interface FinancialDemand {
  readonly start: () => void;
  readonly stop: () => void;
  active: boolean;
}
/** A session owns its consumers; account handoff releases old resources before re-acquiring new ones. */
export function createSessionDemand(
  marketData: TradingMarketDataPort,
  state: TradingState,
  broker: () => IBrokerTerminal,
  symbolInfo: (symbol: string) => Promise<InstrumentInfo>,
  report: (cause: unknown) => void,
) {
  const quotes = new KeyedRefCount<string, QuoteDemand>(demand => {
    const release = demand.release;
    demand.release = undefined;
    demand.consumers.clear();
    // A consumer's dispose never throws: provider cleanup failures are reported.
    try {
      release?.();
    } catch (cause) {
      report(cause);
    }
  });
  // Live updates win over initial/cached snapshots for this account epoch.
  const liveQuoteSymbols = new Set<string>();
  const latestQuotes = new Map<string, TradingQuoteSnapshot>();
  const books = new KeyedRefCount<string, BookDemand>(demand => releaseAll([
    () => demand.release?.(), () => demand.book?.destroy(),
    () => { demand.buffered.length = 0; demand.listeners.clear(); },
  ]));
  const finances = new KeyedRefCount<string, FinancialDemand>(demand => { if (demand.active) demand.stop(); });
  let epoch = 0,
    active = false,
    disposed = false;
  function deliver<T>(listeners: Map<symbol, (value: T) => void>, value: T): void {
    for (const [token, listener] of [...listeners]) {
      if (listeners.get(token) !== listener) continue;
      try { listener(value); } catch (cause) { report(cause); }
    }
  }
  function deliverQuotes(demand: QuoteDemand, value: TradingQuoteSnapshot): void {
    for (const [token, consumer] of [...demand.consumers]) {
      if (demand.consumers.get(token) !== consumer) continue;
      try { consumer.listener(value); } catch (cause) { report(cause); }
    }
  }
  /** Fast if any consumer asks for fast. */
  function effectiveSpeed(demand: QuoteDemand): "fast" | "normal" {
    for (const consumer of demand.consumers.values()) if (consumer.speed === "fast") return "fast";
    return "normal";
  }
  function startQuote(symbol: string, demand: QuoteDemand): void {
    if (!active || demand.release || !demand.consumers.size) return;
    const generation = epoch;
    let listening = true;
    let release: Dispose | undefined;
    const stop = () => {
      if (!listening) return;
      listening = false;
      release?.();
    };
    demand.release = stop;
    demand.speed = effectiveSpeed(demand);
    try {
      release = marketData.acquireQuotes(symbol, demand.speed, (value) => {
        if (!listening || disposed || generation !== epoch) return;
        const current = snapshot(value);
        if (current.source === "snapshot" && liveQuoteSymbols.has(symbol)) return;
        if (current.source !== "snapshot") liveQuoteSymbols.add(symbol);
        const normalized = current.value ? normalizeQuotes(current.value) : undefined;
        const delivered = Object.freeze({ ...current, value: normalized });
        latestQuotes.set(symbol, delivered);
        if (delivered.status === "ready" && normalized) state.quotes.upsert({ ...normalized, id: symbol });
        deliverQuotes(demand, delivered);
      });
      // A synchronous listener may suspend/destroy demand before setup returns.
      if (!listening) release();
    } catch (cause) {
      stop();
      if (demand.release === stop) demand.release = undefined;
      throw cause;
    }
  }
  /** Re-acquires the provider lease when the consumers' effective speed changes. */
  function adjustQuoteSpeed(symbol: string, demand: QuoteDemand): void {
    if (!demand.release || demand.speed === effectiveSpeed(demand)) return;
    // The old lease keeps serving every consumer until the new one is acquired; a failed switch keeps it.
    const previous = demand.release,
      previousSpeed = demand.speed;
    demand.release = undefined;
    try {
      startQuote(symbol, demand);
    } catch (cause) {
      demand.release = previous;
      demand.speed = previousSpeed;
      report(cause);
      return;
    }
    try {
      previous();
    } catch (cause) {
      report(cause);
    }
  }
  function applyDepth(symbol: string, data: DOMData): void {
    const demand = books.get(symbol);
    if (!active || !demand) return;
    if (!demand.book) {
      if (demand.buffered.length >= 1000) {
        demand.buffered.length = 0;
        report(
          new TradingError(
            "broker-unavailable",
            "Depth needs a fresh snapshot.",
          ),
        );
      }
      demand.buffered.push(data);
      return;
    }
    const normalized = demand.book.apply(data);
    if (normalized) deliver(demand.listeners, normalized);
  }
  function startDepth(symbol: string, demand: BookDemand): void {
    if (!active || demand.release || demand.starting) return;
    const generation = epoch;
    demand.starting = true;
    void symbolInfo(symbol)
      .then((instrument) => {
        if (disposed || generation !== epoch || books.get(symbol) !== demand)
          return;
        // Build, replay and acquire locally; only a fully started book becomes the demand's book.
        const book = new DepthBook(instrument.minTick);
        const pending: DOMData[] = [];
        let started = false;
        const deliverDepth = (data: DOMData) => {
          const normalized = book.apply(data);
          if (normalized) deliver(demand.listeners, normalized);
        };
        try {
          for (const data of demand.buffered.splice(0)) deliverDepth(data);
          if (!active || disposed || generation !== epoch || books.get(symbol) !== demand) {
            book.destroy();
            return;
          }
          const release = marketData.acquireDepth(symbol, (data) => {
            if (disposed || generation !== epoch || books.get(symbol) !== demand)
              return;
            try {
              if (started) applyDepth(symbol, data as DOMData);
              else pending.push(data as DOMData);
            } catch (cause) {
              report(cause);
            }
          });
          if (!active || disposed || generation !== epoch || books.get(symbol) !== demand) {
            release();
            book.destroy();
            return;
          }
          demand.book = book;
          demand.release = release;
          started = true;
          for (const data of pending.splice(0)) {
            try { applyDepth(symbol, data); } catch (cause) { report(cause); }
          }
        } catch (cause) {
          book.destroy();
          throw cause;
        }
      })
      .catch(report)
      .finally(() => {
        if (generation === epoch) demand.starting = false;
      });
  }
  function startFinancial(demand: FinancialDemand): void {
    if (demand.active) return;
    try {
      demand.start();
      demand.active = true;
    } catch (cause) {
      // The provider may allocate before throwing. Undo that attempt as well as
      // the local acquisition; failed setup must not leave a phantom owner.
      try {
        demand.stop();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "Financial subscription setup and cleanup failed.",
        );
      }
      throw cause;
    }
  }
  function suspend(): void {
    active = false;
    epoch++;
    liveQuoteSymbols.clear();
    latestQuotes.clear();
    const releases: Dispose[] = [];
    for (const demand of quotes.values()) {
      if (demand.release) releases.push(demand.release);
      demand.release = undefined;
    }
    for (const demand of books.values()) {
      if (demand.release) releases.push(demand.release);
      demand.release = undefined;
      demand.starting = false;
      demand.book?.destroy();
      demand.book = undefined;
      demand.buffered.length = 0;
    }
    for (const demand of finances.values()) {
      if (demand.active) releases.push(demand.stop);
      demand.active = false;
    }
    releaseAll(releases.map(release => () => {
      try { release(); } catch (cause) { report(cause); }
    }));
  }
  return {
    acquireQuotes(
      symbol: string,
      speed: "fast" | "normal",
      listener: (value: TradingQuoteSnapshot) => void,
    ): Dispose {
      if (disposed)
        throw TradingError.disposed();
      const lease = quotes.acquire(symbol, () => ({ consumers: new Map() }));
      const demand = lease.value;
      const token = Symbol();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        demand.consumers.delete(token);
        releaseAll([
          () => {
            if (demand.consumers.size && quotes.get(symbol) === demand) adjustQuoteSpeed(symbol, demand);
          },
          lease.release,
        ]);
      };
      try {
        if (!active) {
          demand.consumers.set(token, { speed, listener });
          listener({ status: "loading" });
          return release;
        }
        // A joining consumer starts from the symbol's current value; the shared lease carries later ones.
        const current = latestQuotes.get(symbol);
        if (current) listener(current);
        demand.consumers.set(token, { speed, listener });
        if (demand.release) adjustQuoteSpeed(symbol, demand);
        else startQuote(symbol, demand);
      } catch (cause) {
        release();
        throw cause;
      }
      return release;
    },
    acquireDepth(
      symbol: string,
      listener: (data: Readonly<DOMData>) => void,
    ): Dispose {
      if (disposed)
        throw TradingError.disposed();
      const lease = books.acquire(symbol, () => ({ listeners: new Map(), buffered: [] }));
      const demand = lease.value;
      const token = Symbol();
      demand.listeners.set(token, listener);
      const initial = demand.book?.snapshot();
      if (initial) listener(initial);
      startDepth(symbol, demand);
      return () => {
        if (!demand.listeners.delete(token)) return;
        lease.release();
      };
    },
    acquireFinancial(kind: "equity" | "margin" | "pip", symbol = ""): Dispose {
      if (kind === "equity") symbol = "";
      if (disposed)
        throw TradingError.disposed();
      const current = broker();
      let start: (() => void) | undefined, stop: (() => void) | undefined;
      if (
        kind === "equity" &&
        current.subscribeEquity &&
        current.unsubscribeEquity
      ) {
        start = () => current.subscribeEquity!();
        stop = () => current.unsubscribeEquity!();
      }
      if (
        kind === "margin" &&
        current.subscribeMarginAvailable &&
        current.unsubscribeMarginAvailable
      ) {
        start = () => current.subscribeMarginAvailable!(symbol);
        stop = () => current.unsubscribeMarginAvailable!(symbol);
      }
      if (
        kind === "pip" &&
        current.subscribePipValue &&
        current.unsubscribePipValue
      ) {
        start = () => current.subscribePipValue!(symbol);
        stop = () => current.unsubscribePipValue!(symbol);
      }
      if (!start || !stop)
        throw new TradingError(
          "unsupported",
          "This financial information is unavailable.",
        );
      const key = `${kind}:${symbol}`;
      const lease = finances.acquire(key, () => ({ start, stop, active: false }));
      const demand = lease.value;
      try {
        if (active) startFinancial(demand);
      } catch (cause) {
        lease.release();
        throw cause;
      }
      return lease.release;
    },
    refreshFinancial(symbol: string): void {
      if (disposed || !active) return;
      for (const [key, demand] of finances) {
        if (key !== `margin:${symbol}` && key !== `pip:${symbol}`) continue;
        try {
          if (demand.active) demand.stop();
          demand.active = false;
          startFinancial(demand);
        } catch (cause) {
          report(cause);
        }
      }
    },
    hostQuotes(symbol: string, value: TradingQuotes): void {
      if (disposed || !active) return;
      liveQuoteSymbols.add(symbol);
      const normalized = normalizeQuotes({
        ...state.quotes.get(symbol),
        ...value,
      });
      state.quotes.upsert({ ...normalized, id: symbol });
      const delivered: TradingQuoteSnapshot = Object.freeze({
        status: "ready",
        source: "stream",
        value: normalized,
      });
      latestQuotes.set(symbol, delivered);
      const demand = quotes.get(symbol);
      if (demand) deliverQuotes(demand, delivered);
    },
    hostDepth: applyDepth,
    suspend,
    resume(): void {
      if (disposed || active) return;
      active = true;
      for (const [symbol, demand] of quotes) {
        try {
          startQuote(symbol, demand);
        } catch (cause) {
          report(cause);
        }
      }
      for (const [symbol, demand] of books) startDepth(symbol, demand);
      for (const demand of finances.values()) {
        try {
          startFinancial(demand);
        } catch (cause) {
          report(cause);
        }
      }
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      releaseAll([suspend, () => quotes.releaseAll(), () => books.releaseAll(), () => finances.releaseAll()]);
    },
  };
}
