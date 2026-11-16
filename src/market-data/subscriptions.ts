import { KeyedRefCount, releaseAll } from "../core/keyed-ref-count.js";
import type {
  DOMData,
  TradingQuotes,
} from "../contracts/broker.js";
import type {
  IDatafeedChartApi,
  IDatafeedQuotesApi,
  QuoteData,
} from "../contracts/market-data.js";
import type {
  Dispose,
  TradingMarketDataPort,
  TradingQuoteSnapshot,
} from "../contracts/ports.js";
import { equalData, snapshot } from "../core/immutable.js";
import { TradingError } from "../core/errors.js";
import { DepthBook } from "./depth-book.js";
type Provider = Partial<IDatafeedQuotesApi> &
  Pick<IDatafeedChartApi, "subscribeDepth" | "unsubscribeDepth">;
interface QuoteDemand {
  readonly listeners: Map<
    symbol,
    {
      readonly speed: "fast" | "normal";
      readonly callback: (value: TradingQuoteSnapshot) => void;
    }
  >;
  epoch: number;
  current: TradingQuoteSnapshot;
  latest?: Readonly<TradingQuotes>;
  speed?: "fast" | "normal";
  guid?: string;
  queued: boolean;
  arrival: number;
}
interface DepthDemand {
  readonly listeners: Set<(value: Readonly<DOMData>) => void>;
  readonly book: DepthBook;
  epoch: number;
  guid?: string;
  starting: boolean;
}
export interface TradingMarketDataAdapter extends TradingMarketDataPort {
  pushQuotes(symbol: string, value: TradingQuotes): void;
  pushDepth(symbol: string, value: DOMData): void;
  destroy(): void;
}
export function normalizeQuotes(data: TradingQuotes): Readonly<TradingQuotes> {
  const result: TradingQuotes = {};
  for (const key of [
    "trade",
    "size",
    "bid",
    "bid_size",
    "ask",
    "ask_size",
    "spread",
    "lastSize",
  ] as const) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TradingError("invalid-input", `Invalid quote ${key}.`);
    result[key] = value;
  }
  for (const key of [
    "isDelayed",
    "isHalted",
    "isHardToBorrow",
    "isNotShortable",
  ] as const) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean")
      throw new TradingError("invalid-input", `Invalid quote ${key}.`);
    result[key] = value;
  }
  return snapshot(result);
}
function quoteValues(data: QuoteData): TradingQuoteSnapshot {
  if (data.s === "error")
    return Object.freeze({
      status: "error",
      error: "Quotes are unavailable for this symbol.",
    });
  const values: TradingQuotes = {};
  for (const key of ["bid", "ask", "spread"] as const)
    if (data.v[key] !== undefined) values[key] = data.v[key];
  if (data.v.lp !== undefined) values.trade = data.v.lp;
  return Object.freeze({ status: "ready", value: normalizeQuotes(values) });
}
/** Widget-local, symbol-keyed demand; duplicate consumers share provider subscriptions. */
export function createTradingMarketData(
  provider: Provider,
  tickForSymbol: (symbol: string) => number,
  diagnostic: (message: string) => void = () => {},
): TradingMarketDataAdapter {
  const quotes = new KeyedRefCount<string, QuoteDemand>(demand => {
    demand.epoch++;
    releaseAll([() => { if (demand.guid) provider.unsubscribeQuotes?.(demand.guid); }, () => demand.listeners.clear()]);
  });
  const depth = new KeyedRefCount<string, DepthDemand>(demand => {
    demand.epoch++;
    releaseAll([
      () => { if (demand.guid) provider.unsubscribeDepth?.(demand.guid); },
      () => demand.listeners.clear(), () => demand.book.destroy(),
    ]);
  });
  const namespace = crypto.randomUUID();
  let sequence = 0;
  let disposed = false;
  function publish(demand: QuoteDemand, value: TradingQuoteSnapshot): void {
    if (value.status === "ready" && value.value) {
      demand.latest = normalizeQuotes({ ...demand.latest, ...value.value });
      value = Object.freeze({ ...value, value: demand.latest });
    }
    if (equalData(demand.current, value)) return;
    demand.current = value;
    for (const listener of [...demand.listeners.values()])
      listener.callback(value);
  }
  function schedule(symbol: string, demand: QuoteDemand): void {
    if (demand.queued) return;
    demand.queued = true;
    queueMicrotask(() => {
      demand.queued = false;
      if (disposed || quotes.get(symbol) !== demand) return;
      const speed = [...demand.listeners.values()].some(
        (listener) => listener.speed === "fast",
      )
        ? "fast"
        : "normal";
      if (demand.guid && demand.speed === speed) return;
      demand.epoch++;
      if (demand.guid) provider.unsubscribeQuotes?.(demand.guid);
      demand.guid = undefined;
      demand.speed = speed;
      if (
        !provider.getQuotes ||
        !provider.subscribeQuotes ||
        !provider.unsubscribeQuotes
      ) {
        publish(demand, {
          status: "error",
          source: "snapshot",
          error: "Live quotes are unavailable.",
        });
        return;
      }
      const epoch = demand.epoch;
      const guid = `${namespace}:quotes:${++sequence}`;
      demand.guid = guid;
      const live = () =>
        !disposed && quotes.get(symbol) === demand && demand.epoch === epoch;
      let initial = true;
      const initialArrival = demand.arrival;
      const apply = (rows: QuoteData[], source: "snapshot" | "stream") => {
        if (!live()) return;
        for (const row of rows)
          if (row.n === symbol) {
            try {
              publish(demand, { ...quoteValues(row), source });
            } catch (cause) {
              publish(demand, {
                status: "error",
                source,
                error: "The provider returned invalid quotes.",
              });
              diagnostic(String(cause));
            }
          }
      };
      const finish = (rows: QuoteData[], error?: string) => {
        if (!live() || !initial) return;
        initial = false;
        if (demand.arrival !== initialArrival) return;
        if (error)
          publish(demand, { status: "error", source: "snapshot", error });
        else apply(rows, "snapshot");
      };
      try {
        provider.subscribeQuotes(
          speed === "normal" ? [symbol] : [],
          speed === "fast" ? [symbol] : [],
          (rows) => {
            if (!live()) return;
            for (const row of rows) {
              if (row.n !== symbol) continue;
              demand.arrival++;
              apply([row], "stream");
            }
          },
          guid,
        );
        provider.getQuotes(
          [symbol],
          (rows) => finish(rows),
          () => finish([], "Quotes are unavailable."),
        );
      } catch (cause) {
        finish([], "Live quotes are unavailable.");
        diagnostic(String(cause));
      }
    });
  }
  function startDepth(symbol: string, demand: DepthDemand): void {
    if (disposed || depth.get(symbol) !== demand) return;
    if (!provider.subscribeDepth || !provider.unsubscribeDepth)
      throw new TradingError("unsupported", "Depth of Market is unavailable.");
    const epoch = ++demand.epoch;
    demand.starting = true;
    let guid: string;
    try {
      guid = subscribeDepth(symbol, epoch, demand);
    } finally {
      demand.starting = false;
    }
    if (disposed || depth.get(symbol) !== demand)
      provider.unsubscribeDepth(guid);
    else demand.guid = guid;
  }
  function subscribeDepth(symbol: string, epoch: number, demand: DepthDemand): string {
    return provider.subscribeDepth!(symbol, (data) => {
      if (disposed || depth.get(symbol) !== demand || demand.epoch !== epoch)
        return;
      try {
        const normalized = demand.book.apply(data);
        if (normalized)
          for (const listener of [...demand.listeners]) listener(normalized);
      } catch (cause) {
        diagnostic(String(cause));
        if (
          cause instanceof TradingError &&
          cause.code === "broker-unavailable"
        ) {
          // Defer restart so synchronous provider callbacks cannot recurse into subscribeDepth.
          demand.epoch++;
          queueMicrotask(() => {
            if (disposed || depth.get(symbol) !== demand) return;
            try {
              if (demand.guid) provider.unsubscribeDepth?.(demand.guid);
              demand.guid = undefined;
              startDepth(symbol, demand);
            } catch (restart) {
              // A later acquireDepth retries; the restart must not escape as an unhandled error.
              demand.guid = undefined;
              diagnostic(String(restart));
            }
          });
        }
      }
    });
  }
  return {
    acquireQuotes(symbol, speed, callback): Dispose {
      if (disposed)
        throw TradingError.disposed("This market-data connection is closed.");
      const lease = quotes.acquire(symbol, () => ({
        listeners: new Map(), epoch: 0, current: { status: "loading", source: "snapshot" }, queued: false, arrival: 0,
      }));
      const demand = lease.value;
      const token = Symbol();
      demand.listeners.set(token, { speed, callback });
      const owned = demand;
      const release = () => {
        if (!owned.listeners.delete(token)) return;
        lease.release();
        if (owned.listeners.size) schedule(symbol, owned);
      };
      try {
        callback({ ...demand.current, source: "snapshot" });
        schedule(symbol, demand);
      } catch (cause) {
        release();
        throw cause;
      }
      return release;
    },
    acquireDepth(symbol, callback): Dispose {
      if (disposed)
        throw TradingError.disposed("This market-data connection is closed.");
      if (!provider.subscribeDepth || !provider.unsubscribeDepth)
        throw new TradingError(
          "unsupported",
          "Depth of Market is unavailable.",
        );
      const lease = depth.acquire(symbol, () => ({
        listeners: new Set(), book: new DepthBook(tickForSymbol(symbol)), epoch: 0, starting: false,
      }), callback);
      const demand = lease.value;
      demand.listeners.add(callback);
      const owned = demand;
      const release = () => {
        if (!owned.listeners.delete(callback)) return;
        lease.release();
      };
      try {
        const current = demand.book.snapshot();
        if (current) callback(current);
        if (!demand.guid && !demand.starting) startDepth(symbol, demand);
      } catch (cause) {
        demand.starting = false;
        release();
        throw cause;
      }
      return release;
    },
    pushQuotes(symbol, value) {
      const demand = quotes.get(symbol);
      if (!disposed && demand) {
        demand.arrival++;
        publish(demand, {
          status: "ready",
          source: "stream",
          value: normalizeQuotes(value),
        });
      }
    },
    pushDepth(symbol, value) {
      const demand = depth.get(symbol);
      if (disposed || !demand) return;
      const normalized = demand.book.apply(value);
      if (normalized)
        for (const listener of [...demand.listeners]) listener(normalized);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      releaseAll([() => quotes.releaseAll(), () => depth.releaseAll()]);
    },
  };
}
