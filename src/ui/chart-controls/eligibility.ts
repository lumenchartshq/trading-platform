import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import type {
  ReadonlyValue,
  TradingChartPort,
  TradingSymbolContext,
} from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { useTradingValue } from "../primitives.js";

function useVisibility(
  value: ReadonlyValue<boolean> | undefined,
): () => boolean {
  if (value) return useTradingValue(value);
  return () => true;
}
/** Metadata and broker eligibility have separate ownership from quote demand. Late reads cannot re-enable an old binding. */
export function useChartQuoteEligibility(
  session: TradingSession,
  chart: TradingChartPort,
  surface?: ReadonlyValue<boolean>,
) {
  const binding = useTradingValue(chart.binding);
  const connection = useTradingValue(session.state.connection);
  const chartVisible = useVisibility(chart.visible),
    surfaceVisible = useVisibility(surface);
  const [context, setContext] = createSignal<TradingSymbolContext>();
  createEffect(() => {
    binding();
    let active = true,
      revision = 0;
    setContext(undefined);
    const publish = (value: TradingSymbolContext) => {
      if (!active) return;
      revision++;
      setContext(value.symbol === binding().symbol ? value : undefined);
    };
    const release = chart.subscribeSymbolContext?.(publish);
    const captured = revision;
    void chart.symbolContext().then(
      (value) => {
        if (active && revision === captured) publish(value);
      },
      () => {},
    );
    onCleanup(() => {
      active = false;
      release?.();
    });
  });
  const key = createMemo(
    () => ({
      symbol: binding().symbol,
      generation: connection().generation,
      ready: connection().phase === "ready",
    }),
    undefined,
    {
      equals: (a, b) =>
        a?.symbol === b?.symbol &&
        a?.generation === b?.generation &&
        a?.ready === b?.ready,
    },
  );
  const [tradability] = createResource(
    () => (key().ready ? key() : undefined),
    (value) => session.tradability(value.symbol),
  );
  const tradable = () =>
    tradability.state === "ready" ? tradability().tradable : undefined;
  const eligible = () => {
    const current = context();
    return (
      chartVisible() &&
      surfaceVisible() &&
      key().ready &&
      tradable() === true &&
      current?.symbol === binding().symbol &&
      current.resolved &&
      current.tradable &&
      (current.hasBars ||
        session.features.show_buy_sell_buttons_on_unsupported_resolution)
    );
  };
  /** The broker's short reason, shown in the legend while the symbol is not tradable. */
  const shortReason = () =>
    tradability.state === "ready" && !tradability().tradable
      ? tradability().shortReason
      : undefined;
  return Object.assign(eligible, { shortReason });
}
