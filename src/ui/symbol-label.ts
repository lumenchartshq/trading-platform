import { createResource } from "solid-js";
import { symbolLabel } from "../core/features.js";
import type { TradingSession } from "../core/session.js";

/**
 * The symbol a trading panel shows: the broker's display symbol once the instrument is known, as the order ticket
 * does, otherwise the chart symbol.
 */
export function createSymbolLabel(session: TradingSession, symbol: () => string) {
  // No symbol, no instrument read.
  const [instrument] = createResource(() => symbol() || undefined, (value) => session.symbolInfo(value));
  return () =>
    symbolLabel(symbol(), session.features, instrument.error ? undefined : instrument()?.brokerSymbol);
}
