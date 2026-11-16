import type {
  TradingClock,
  TradingPresentationPort,
  TradingSymbolSearchResult,
} from "../../contracts/ports.js";
import { ValueStore } from "../../core/value-store.js";

/** The paged result window the view renders (a `PagedListWindow` in the mounted UI). */
export interface SymbolResultWindow {
  readonly count: number;
  at(index: number): TradingSymbolSearchResult | undefined;
  reset(items: readonly TradingSymbolSearchResult[]): void;
  append(items: readonly TradingSymbolSearchResult[], sourceStart: number): void;
  ensure(indices: readonly number[]): Promise<void>;
  cancel(): void;
}
export interface SymbolSearchState {
  readonly query: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly more: boolean;
  readonly selected: number;
  /** Arrow keys moved the selection, so the list follows it. */
  readonly keyboard: boolean;
  /** Bumped whenever rows change. */
  readonly rows: number;
}
export interface SymbolSearchOptions {
  readonly clock: TradingClock;
  search(query: string): Promise<readonly TradingSymbolSearchResult[]>;
  readonly searchPage?: TradingPresentationPort["searchSymbolsPage"];
  choose(symbol: string): void;
  createWindow(
    load: (start: number) => Promise<readonly TradingSymbolSearchResult[]>,
    changed: () => void,
  ): SymbolResultWindow;
}
const PAGE = 50;
const UNPAGED_LIMIT = 20;
const DEBOUNCE = 200;

/**
 * Ticket symbol search without the view: debounced requests where only the newest may publish, pagination with
 * a catalog revision that restarts the search when the host's catalog changes, retry of a failed page range,
 * and keyboard selection.
 */
export function createSymbolSearchController(options: SymbolSearchOptions) {
  const state = new ValueStore<SymbolSearchState>({
    query: "",
    loading: false,
    failed: false,
    more: false,
    selected: 0,
    keyboard: false,
    rows: 0,
  });
  const patch = (changes: Partial<SymbolSearchState>) => state.set({ ...state.get(), ...changes });
  const changed = () => patch({ rows: state.get().rows + 1 });
  let request = 0,
    offset = 0;
  let catalogRevision: string | undefined;
  let failedRange: readonly number[] | undefined;
  let timer: unknown;
  let disposed = false;
  const results = options.createWindow(async (start) => {
    const current = request;
    const page = await options.searchPage!(state.get().query.trim(), start, PAGE);
    if (current !== request) return [];
    if (catalogRevision && page.revision && catalogRevision !== page.revision) {
      run(state.get().query);
      return [];
    }
    return page.items;
  }, changed);
  const setResults = (items: readonly TradingSymbolSearchResult[]) => {
    results.reset(items);
    changed();
  };
  const clearTimer = () => {
    if (timer !== undefined) options.clock.clearTimeout(timer);
    timer = undefined;
  };
  function run(value: string, chooseFirst = false): void {
    if (disposed) return;
    const current = ++request;
    results.cancel();
    failedRange = undefined;
    patch({ selected: 0, keyboard: false, failed: false, loading: false, more: false });
    if (!value.trim()) {
      setResults([]);
      return;
    }
    patch({ loading: true });
    const source = options.searchPage
      ? options.searchPage(value.trim(), 0, PAGE)
      : options.search(value.trim()).then((items) => ({
          items: items.slice(0, UNPAGED_LIMIT),
          remaining: 0,
          revision: undefined,
        }));
    source.then(
      (page) => {
        if (current !== request) return;
        catalogRevision = page.revision;
        offset = page.items.length;
        patch({ loading: false, more: page.remaining > 0 });
        setResults(page.items);
        if (chooseFirst && page.items[0]) choose(page.items[0].symbol);
      },
      () => {
        if (current !== request) return;
        setResults([]);
        patch({ loading: false, failed: true });
      },
    );
  }
  function choose(symbol: string): void {
    request++;
    results.cancel();
    clearTimer();
    patch({ query: "" });
    setResults([]);
    options.choose(symbol);
  }
  async function ensureRange(indices: readonly number[], retry = false): Promise<void> {
    if (state.get().failed && !retry) return;
    const current = request;
    if (retry) {
      failedRange = undefined;
      patch({ failed: false });
    }
    try {
      await results.ensure(indices);
    } catch {
      if (current === request) {
        failedRange = indices.slice();
        patch({ failed: true });
      }
    }
  }
  function loadMore(): void {
    if (failedRange) {
      void ensureRange(failedRange, true);
      return;
    }
    const source = options.searchPage;
    const { loading, more, query } = state.get();
    if (!source || loading || !more) return;
    const current = request,
      start = offset;
    patch({ failed: false, loading: true });
    source(query.trim(), start, PAGE).then(
      (page) => {
        if (current !== request) return;
        if (catalogRevision && page.revision && catalogRevision !== page.revision) {
          run(query);
          return;
        }
        results.append(page.items, start);
        offset += page.items.length;
        changed();
        patch({ more: page.remaining > 0 && page.items.length > 0, loading: false });
      },
      () => {
        if (current === request) patch({ loading: false, failed: true });
      },
    );
  }
  return {
    state,
    results,
    /** Text changed: stale results are dropped at once and the search runs after a short pause. */
    input(value: string): void {
      request++;
      failedRange = undefined;
      patch({ query: value, failed: false, loading: false, more: false });
      setResults([]);
      clearTimer();
      timer = options.clock.setTimeout(() => {
        timer = undefined;
        run(value);
      }, DEBOUNCE);
    },
    /** Moves the keyboard selection; returns false when there is nothing to move through. */
    move(direction: 1 | -1): boolean {
      const count = results.count;
      if (!count) return false;
      const selected = Math.max(0, Math.min(count - 1, state.get().selected + direction));
      patch({ keyboard: true, selected });
      return true;
    },
    /** Enter: choose the selected result, or search now and choose the first. */
    async submit(): Promise<void> {
      if (results.count) {
        const current = request,
          index = state.get().selected;
        try {
          await results.ensure([index]);
          const result = results.at(index);
          if (current === request && index === state.get().selected && result) choose(result.symbol);
        } catch {
          if (current === request) {
            failedRange = [index];
            patch({ failed: true });
          }
        }
        return;
      }
      clearTimer();
      run(state.get().query, true);
    },
    retry(): void {
      if (results.count) loadMore();
      else run(state.get().query);
    },
    choose,
    loadMore,
    ensureRange: (indices: readonly number[]) => ensureRange(indices),
    destroy(): void {
      disposed = true;
      request++;
      results.cancel();
      clearTimer();
      state.destroy();
    },
  };
}
export type SymbolSearchController = ReturnType<typeof createSymbolSearchController>;
