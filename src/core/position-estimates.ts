import type {
  InstrumentInfo,
  Side,
  TradingQuotes,
} from "../contracts/broker.js";
import type { EntityReader } from "./entity-store.js";
import type { TradingSession } from "./session.js";
import { EntityStore } from "./entity-store.js";
import { entityReader } from "./readers.js";
import { DisposalScope } from "./disposal.js";
import type { ProfitDisplayMode } from "./financial-rules.js";
import { isProfitDisplayMode } from "./display-preferences.js";
import { TradingError } from "./errors.js";
import { positionProfit } from "./financial-rules.js";
import type { FinancialValue } from "./trading-state.js";
interface PositionInput {
  readonly id: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: number;
  readonly avgPrice?: number;
  readonly price?: number;
}
interface Channel {
  readonly ids: Set<string>;
  readonly scope: DisposalScope;
  readonly generation: number;
  releasePip?: () => void;
  instrument?: InstrumentInfo;
  quotes?: Readonly<TradingQuotes>;
}
/** Display-only estimates. Demand and work are indexed by the positions' symbols. */
export function createPositionEstimates<T extends PositionInput>(
  session: Pick<
    TradingSession,
    "state" | "symbolInfo" | "acquireQuotes" | "acquireFinancial"
  > &
    Partial<Pick<TradingSession, "policy">>,
  source: EntityReader<T>,
  individual = false,
  onError: (cause: unknown) => void = () => {},
) {
  const values = new EntityStore<FinancialValue>(() => {});
  const channels = new Map<string, Channel>(),
    symbols = new Map<string, string>();
  let mode: ProfitDisplayMode = "money";
  let permittedSymbols: ReadonlySet<string> | undefined;
  let wanted = false,
    running = false,
    disposed = false,
    generation = -1;
  const current = (symbol: string, channel: Channel) =>
    running &&
    !disposed &&
    channels.get(symbol) === channel &&
    session.state.connection.get().phase === "ready" &&
    session.state.connection.get().generation === channel.generation;
  const safely = (work: () => void) => {
    try {
      work();
    } catch (cause) {
      onError(cause);
    }
  };
  function update(id: string, channel: Channel): void {
    const position = source.get(id);
    const entry = individual ? position?.price : position?.avgPrice;
    if (!position || entry === undefined || !channel.instrument) {
      values.remove(id);
      return;
    }
    const value = positionProfit({
      position: { side: position.side, qty: position.qty, avgPrice: entry },
      instrument: channel.instrument,
      quotes: channel.quotes,
      pipValues:
        mode === "money"
          ? session.state.pipValues.get(position.symbol)
          : undefined,
      mode,
      supportPLUpdate: false,
      source: "table",
      inInstrumentCurrency:
        session.policy?.get().flags.positionPLInInstrumentCurrency === true,
    });
    if (value === undefined) values.remove(id);
    else values.upsert({ id, value });
  }
  function updateSymbol(symbol: string, channel: Channel): void {
    if (!current(symbol, channel)) return;
    values.transaction(() => {
      for (const id of channel.ids) update(id, channel);
    });
  }
  function stopPips(channel: Channel): void {
    const release = channel.releasePip;
    channel.releasePip = undefined;
    if (release) safely(release);
  }
  function startPips(symbol: string, channel: Channel): void {
    // Without broker pip streams the static instrument pip value is the estimate; there is nothing to acquire.
    if (mode !== "money" || channel.releasePip || session.policy?.get().pipValues === false) return;
    safely(() => {
      channel.releasePip = session.acquireFinancial("pip", symbol);
    });
  }
  function channelFor(symbol: string): Channel {
    const existing = channels.get(symbol);
    if (existing) return existing;
    const channel: Channel = {
      ids: new Set(),
      scope: new DisposalScope(),
      generation,
    };
    channels.set(symbol, channel);
    safely(() =>
      channel.scope.own(
        session.acquireQuotes(symbol, "normal", (quote) => {
          if (!current(symbol, channel)) return;
          channel.quotes = quote.status === "ready" ? quote.value : undefined;
          safely(() => updateSymbol(symbol, channel));
        }),
      ),
    );
    // Pip values are in account currency. A static instrument pip value is the
    // fallback if the optional dynamic subscription cannot be acquired.
    channel.scope.own(() => stopPips(channel));
    startPips(symbol, channel);
    void session.symbolInfo(symbol).then(
      (instrument) => {
        if (!current(symbol, channel)) return;
        channel.instrument = instrument;
        safely(() => updateSymbol(symbol, channel));
      },
      (cause) => {
        if (current(symbol, channel)) onError(cause);
      },
    );
    return channel;
  }
  function remove(id: string): void {
    const symbol = symbols.get(id);
    symbols.delete(id);
    values.remove(id);
    if (!symbol) return;
    const channel = channels.get(symbol);
    if (!channel) return;
    channel.ids.delete(id);
    if (channel.ids.size) return;
    channels.delete(symbol);
    safely(() => channel.scope.destroy());
  }
  function refresh(id: string): void {
    const position = source.get(id);
    if (
      !position ||
      (permittedSymbols && !permittedSymbols.has(position.symbol))
    ) {
      remove(id);
      return;
    }
    if (symbols.get(id) !== position.symbol) remove(id);
    const channel = channelFor(position.symbol);
    symbols.set(id, position.symbol);
    channel.ids.add(id);
    update(id, channel);
  }
  function stop(): void {
    running = false;
    const owned = [...channels.values()];
    channels.clear();
    symbols.clear();
    for (const channel of owned) safely(() => channel.scope.destroy());
    values.replace([]);
  }
  function reconcile(): void {
    const connection = session.state.connection.get();
    const enabled = wanted && connection.phase === "ready";
    if (running && (!enabled || generation !== connection.generation)) stop();
    if (!enabled || running || disposed) return;
    running = true;
    generation = connection.generation;
    values.transaction(() => {
      for (const id of source.ids()) refresh(id);
    });
  }
  const releaseSource = source.subscribeChanges((change) => {
    if (!running) return;
    values.transaction(() => {
      for (const id of change.removed) remove(id);
      for (const id of [...change.added, ...change.updated]) refresh(id);
    });
  });
  const releasePips = session.state.pipValues.subscribeChanges((change) => {
    if (!running || mode !== "money") return;
    for (const symbol of [
      ...change.added,
      ...change.updated,
      ...change.removed,
    ]) {
      const channel = channels.get(symbol);
      if (channel) safely(() => updateSymbol(symbol, channel));
    }
  });
  const releaseConnection = session.state.connection.subscribe(reconcile);
  return {
    reader: entityReader(values),
    setMode(value: ProfitDisplayMode): void {
      if (disposed) return;
      if (!isProfitDisplayMode(value))
        throw new TradingError(
          "invalid-input",
          "Choose a valid profit display.",
        );
      if (value === mode) return;
      mode = value;
      if (!running) return;
      values.transaction(() => {
        for (const [symbol, channel] of channels) {
          if (mode === "money") startPips(symbol, channel);
          else stopPips(channel);
          updateSymbol(symbol, channel);
        }
      });
    },
    setSymbols(symbols: readonly string[]): void {
      if (disposed) return;
      const next = new Set(symbols);
      if (
        permittedSymbols &&
        next.size === permittedSymbols.size &&
        [...next].every((symbol) => permittedSymbols!.has(symbol))
      )
        return;
      permittedSymbols = next;
      if (running)
        values.transaction(() => {
          for (const id of source.ids()) refresh(id);
        });
    },
    setActive(value: boolean): void {
      if (disposed) return;
      wanted = value;
      reconcile();
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      wanted = false;
      stop();
      releaseSource();
      releasePips();
      releaseConnection();
      values.destroy();
    },
  };
}
