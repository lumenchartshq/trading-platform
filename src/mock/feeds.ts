import type { DOMData } from '../contracts/broker.js';
import type { IDatafeedChartApi, IDatafeedQuotesApi, QuoteData, QuotesCallback } from '../contracts/market-data.js';
import { createTradingMarketData } from '../market-data/subscriptions.js';
/** Scripted quote/depth provider; it owns fixture data and never reads chart bars. */
export function createSimulationFeeds(seed = 1) {
  let randomState = seed >>> 0;
  let sequence = 0;
  const quotes = new Map<string, QuoteData>();
  const prices = new Map<string, number>();
  const books = new Map<string, DOMData>();
  const quoteListeners = new Map<string, { symbols: Set<string>; callback: QuotesCallback }>();
  const depthListeners = new Map<string, { symbol: string; callback: (data: DOMData) => void }>();
  const provider: IDatafeedQuotesApi & Pick<IDatafeedChartApi, 'subscribeDepth' | 'unsubscribeDepth'> = {
    getQuotes: (symbols, callback) => callback(symbols.map(symbol => structuredClone(quotes.get(symbol) ?? { n: symbol, s: 'error', v: {} }))),
    subscribeQuotes: (symbols, fast, callback, guid) => { quoteListeners.set(guid, { symbols: new Set([...symbols, ...fast]), callback }); },
    unsubscribeQuotes: guid => { quoteListeners.delete(guid); },
    subscribeDepth: (symbol, callback) => {
      const id = `simulation-depth-${++sequence}`; depthListeners.set(id, { symbol, callback });
      const current = books.get(symbol); if (current) callback(structuredClone(current)); return id;
    },
    unsubscribeDepth: guid => { depthListeners.delete(guid); },
  };
  const marketData = createTradingMarketData(provider, () => 0.01);
  const setQuote = (symbol: string, price: number) => {
    const data: QuoteData = { n: symbol, s: 'ok', v: { lp: price, bid: price - 0.01, ask: price + 0.01 } };
    quotes.set(symbol, data);
    prices.set(symbol, price);
    for (const listener of quoteListeners.values()) if (listener.symbols.has(symbol)) listener.callback([structuredClone(data)]);
  };
  const setDepth = (symbol: string, data: DOMData) => {
    // Keep an authoritative book for subscribers that join after scripted deltas.
    if (data.snapshot) books.set(symbol, structuredClone(data));
    else {
      const old = books.get(symbol) ?? { snapshot: true, bids: [], asks: [] };
      for (const side of ['bids', 'asks'] as const) {
        const levels = new Map(old[side].map(level => [level.price, level]));
        for (const level of data[side]) { if (level.volume === 0) levels.delete(level.price); else levels.set(level.price, structuredClone(level)); }
        old[side] = [...levels.values()].sort((a, b) => a.price - b.price);
      }
      books.set(symbol, old);
    }
    for (const listener of depthListeners.values()) if (listener.symbol === symbol) listener.callback(structuredClone(data));
  };
  setQuote('SIM:X', 100);
  setDepth('SIM:X', { snapshot: true, bids: [{ price: 99.99, volume: 50 }, { price: 99.98, volume: 100 }], asks: [{ price: 100.01, volume: 60 }, { price: 100.02, volume: 120 }] });
  return {
    provider, marketData, setQuote, setDepth,
    /** Last scripted trade price, or undefined while the symbol has no quote. */
    lastPrice: (symbol: string): number | undefined => prices.get(symbol),
    quoteError(symbol: string) { const data: QuoteData = { n: symbol, s: 'error', v: {} }; quotes.set(symbol, data); for (const listener of quoteListeners.values()) if (listener.symbols.has(symbol)) listener.callback([data]); },
    tick(symbol = 'SIM:X'): number { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; const price = 100 + (randomState % 1000) / 100; setQuote(symbol, price); return price; },
    counts: () => ({ quotes: quoteListeners.size, depth: depthListeners.size }),
    destroy: () => { marketData.destroy(); quoteListeners.clear(); depthListeners.clear(); },
  };
}
