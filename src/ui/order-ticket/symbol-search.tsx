import { PagedListWindow, VirtualList } from "../../vendor/solid-ui/index.js";
import { onCleanup, Show } from "solid-js";
import type {
  TradingClock,
  TradingPresentationPort,
  TradingSymbolSearchResult,
} from "../../contracts/ports.js";
import { createSymbolSearchController } from "./symbol-search-controller.js";
import { TradingButton, useTradingValue } from "../primitives.js";

/**
 * `supportSymbolSearch`: find another symbol for this ticket through the host's datafeed search.
 * Results are a list of buttons; choosing one reopens the ticket for that symbol.
 */
export function TicketSymbolSearch(props: {
  clock: TradingClock;
  search(query: string): Promise<readonly TradingSymbolSearchResult[]>;
  searchPage?: TradingPresentationPort["searchSymbolsPage"];
  choose(symbol: string): void;
  disabled?: boolean;
}) {
  let window!: PagedListWindow<TradingSymbolSearchResult>;
  const controller = createSymbolSearchController({
    clock: props.clock,
    search: (query) => props.search(query),
    searchPage: props.searchPage ? (query, start, limit) => props.searchPage!(query, start, limit) : undefined,
    choose: (symbol) => props.choose(symbol),
    createWindow: (load, changed) => (window = new PagedListWindow((item) => item.symbol, load, changed)),
  });
  onCleanup(() => controller.destroy());
  const view = useTradingValue(controller.state);
  const query = () => view().query;
  const failed = () => view().failed;
  const more = () => view().more;
  const loading = () => view().loading;
  const selected = () => view().selected;
  const keyboard = () => view().keyboard;
  const rowRevision = () => view().rows;
  const count = () => {
    rowRevision();
    return window.count;
  };
  const at = (index: number) => {
    rowRevision();
    return window.at(index);
  };
  const choose = controller.choose;
  const loadMore = controller.loadMore;
  return (
    <div class="trading-symbol-search">
      <input
        type="search"
        aria-label="Search symbol"
        placeholder="Search symbol"
        autocomplete="off"
        disabled={props.disabled}
        value={query()}
        onInput={(event) => controller.input(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (controller.move(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          void controller.submit();
        }}
      />
      <Show when={failed()}>
        <p role="alert" class="trading-error">
          Symbol search is unavailable.
          <TradingButton onClick={() => controller.retry()}>Try again</TradingButton>
        </p>
      </Show>
      <Show when={count() > 0}>
        <VirtualList
          count={count()}
          residentCount={window.residentCount}
          rowHeight={40}
          itemKey={(index) => {
            rowRevision();
            return window.keyAt(index);
          }}
          class="trading-symbol-results"
          style={{ height: "240px" }}
          label="Symbol results"
          resetKey={query()}
          canLoadMore={more() && !loading() && !failed()}
          onEndReached={loadMore}
          selectedIndex={selected()}
          followSelection={keyboard()}
          onRange={(_start, _end, indices) => {
            void controller.ensureRange(indices);
          }}
          render={(index) => (
            <Show when={at(index())} keyed>
              {(result) => (
                <TradingButton
                  role="option"
                  aria-selected={selected() === index()}
                  aria-posinset={index() + 1}
                  aria-setsize={more() ? -1 : count()}
                  onClick={() => choose(result.symbol)}
                >
                  <strong>{result.symbol}</strong>
                  <Show when={result.description}>
                    <span class="trading-muted"> {result.description}</span>
                  </Show>
                </TradingButton>
              )}
            </Show>
          )}
        />
      </Show>
    </div>
  );
}
