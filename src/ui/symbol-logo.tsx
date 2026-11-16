import { For, Show, createContext, createResource, useContext } from "solid-js";

/** Host-provided logo lookup; absent when the chart does not enable `show_symbol_logos`. */
export const TradingSymbolLogos = createContext<
  ((symbol: string) => Promise<readonly string[]>) | undefined
>();

/** Decorative logo next to a symbol; the symbol text remains the accessible name. */
export function SymbolLogo(props: { symbol: string; enabled: boolean }) {
  const source = useContext(TradingSymbolLogos);
  const [logos] = createResource(
    () => (props.enabled && source ? props.symbol : undefined),
    async (symbol) => {
      try {
        return (await source!(symbol)) ?? [];
      } catch {
        return [];
      }
    },
  );
  return (
    <Show when={logos()?.length}>
      <span class="trading-symbol-logo" aria-hidden="true">
        <For each={logos()}>
          {(url) => (
            <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" />
          )}
        </For>
      </span>
    </Show>
  );
}
