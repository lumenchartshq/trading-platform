import { createEffect, createMemo, on, onCleanup } from "solid-js";
import type { TradingSession } from "../core/session.js";

/** Acquire only while requested, releasing the previous channel before a new one. */
export function useFinancialLease(
  session: TradingSession,
  kind: "equity" | "margin" | "pip",
  requestedSymbol: () => string | undefined,
): void {
  const symbol = createMemo(requestedSymbol);
  createEffect(on(symbol, current => {
    if (current === undefined) return;
    try {
      onCleanup(session.acquireFinancial(kind, current));
    } catch {
      // Optional live values stay unavailable; static instrument values remain usable.
    }
  }));
}
