import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import type { TradingQuoteSnapshot } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { useTradingValue } from "../primitives.js";
import { createFrameBatch, immediateFrames, type FrameScheduler } from "../../chart/frame-batch.js";

/** One ticket quote lease serves its side buttons, financial inputs and summary. */
export function useTicketMarket(
  session: TradingSession,
  symbol: () => string,
  active: () => boolean = () => true,
  /** Quote display updates wait for this frame; the latest quote of a burst is shown once. Immediate by default. */
  frames: FrameScheduler = immediateFrames,
) {
  const connection = useTradingValue(session.state.connection);
  const context = createMemo(
    () => ({
      symbol: symbol(),
      generation: connection().generation,
      ready: connection().phase === "ready" && active(),
    }),
    undefined,
    {
      equals: (before, after) =>
        before?.symbol === after?.symbol &&
        before?.generation === after?.generation &&
        before?.ready === after?.ready,
    },
  );
  const [quote, setQuote] = createSignal<TradingQuoteSnapshot>({
    status: "loading",
  });
  const [formatters, setFormatters] =
    createSignal<Awaited<ReturnType<TradingSession["formatters"]>>>();
  createEffect(
    on(context, ({ symbol: current, ready }) => {
      setQuote({ status: "loading" });
      setFormatters(undefined);
      if (!current || !ready) return;
      let active = true;
      const display = createFrameBatch<TradingQuoteSnapshot>(frames, (values) => {
        if (active) setQuote(values[values.length - 1]!);
      });
      const release = session.acquireQuotes(current, "fast", (value) => display.queue("quote", value));
      void session.formatters(current).then(
        (value) => {
          if (active) setFormatters(value);
        },
        () => {
          /* Missing broker formatters leave prices visibly unavailable. */
        },
      );
      onCleanup(() => {
        active = false;
        display.destroy();
        release();
      });
    }),
  );
  const price = (value: number | undefined): string => {
    if (value === undefined || !Number.isFinite(value)) return "—";
    try {
      return formatters()?.price.format(value) ?? "—";
    } catch {
      return "—";
    }
  };
  const ready = () => (quote().status === "ready" ? quote().value : undefined);
  const spread = () => {
    const current = ready();
    if (current?.ask === undefined || current.bid === undefined) return "—";
    const custom = formatters()?.spread;
    if (!custom) return price(current.ask - current.bid);
    try {
      return custom.format(current.ask - current.bid);
    } catch {
      return "—";
    }
  };
  return { quote, ready, price, spread };
}
