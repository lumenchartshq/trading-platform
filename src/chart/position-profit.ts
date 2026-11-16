import { positionProfitVisible } from "../core/trading-settings.js";
import { showsIndividualPositions } from "../core/capabilities.js";
import type { INumberFormatter } from "../contracts/broker.js";
import type { TradingSession } from "../core/session.js";
import { profitTickPrecision } from "../core/financial-rules.js";
import type { ProfitDisplayMode } from "../core/financial-rules.js";
import { createPositionEstimates } from "../core/position-estimates.js";
import { TradingError } from "../core/errors.js";
import { profitTickUnit } from "./exit-profit.js";
type PositionKind = "position" | "individualPosition";
interface FormatterEntry {
  readonly generation: number;
  readonly mode: ProfitDisplayMode;
  unit?: string;
  formatter?: INumberFormatter;
}

/** Owns chart profit display and demand, independently of broker-defined table columns. */
export function createChartPositionProfit(
  session: TradingSession,
  changed: (kind: PositionKind, id: string) => void,
  symbolChanged: (symbol: string) => void,
  onError: (cause: unknown) => void,
) {
  const net = createPositionEstimates(
    session,
    session.state.positions,
    false,
    onError,
  );
  const individual = createPositionEstimates(
    session,
    session.state.individualPositions,
    true,
    onError,
  );
  const formatters = new Map<string, FormatterEntry>();
  let disposed = false;
  const releases = (
    [
      ["position", net],
      ["individualPosition", individual],
    ] as const
  ).map(([kind, estimates]) =>
    estimates.reader.subscribeChanges((change) => {
      if (disposed) return;
      for (const id of [...change.added, ...change.updated, ...change.removed])
        changed(kind, id);
    }),
  );
  function profitValue(kind: PositionKind, id: string, position: { readonly extra?: Record<string, unknown> }) {
    const display = session.displaySettings.get();
    return session.policy.get().flags.supportPLUpdate && display.positionProfitDisplay === "money"
      ? position.extra?.pl : (kind === "position" ? net : individual).reader.get(id)?.value;
  }
  function label(
    kind: PositionKind,
    id: string,
    position: {
      readonly symbol: string;
      readonly extra?: Record<string, unknown>;
    },
  ): string | undefined {
    const display = session.displaySettings.get();
    if (!positionProfitVisible(display)) return undefined;
    const mode = display.positionProfitDisplay;
    const value = profitValue(kind, id, position);
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const entry = formatters.get(position.symbol);
    if (
      entry?.generation !== session.state.connection.get().generation ||
      entry.mode !== mode ||
      !entry.formatter
    )
      return undefined;
    try {
      const text = entry.formatter.format(value);
      if (typeof text !== "string")
        throw new TradingError(
          "configuration",
          "Profit formatting is unavailable.",
        );
      if (!text) return undefined;
      if (entry.unit === "%") return `${text}%`;
      return entry.unit ? `${text} ${entry.unit}` : text;
    } catch (cause) {
      entry.formatter = undefined;
      onError(cause);
      return undefined;
    }
  }
  function synchronize(
    symbols: readonly string[],
    withPositions: readonly string[],
  ): void {
    if (disposed) return;
    const display = session.displaySettings.get(),
      mode = display.positionProfitDisplay;
    const selected = new Set(symbols);
    for (const symbol of formatters.keys())
      if (!selected.has(symbol)) formatters.delete(symbol);
    const flags = session.policy.get().flags;
    const derived =
      positionProfitVisible(display) &&
      (mode !== "money" || !flags.supportPLUpdate);
    if (!derived) {
      net.setActive(false);
      individual.setActive(false);
    }
    net.setMode(mode);
    individual.setMode(mode);
    net.setSymbols(symbols);
    individual.setSymbols(symbols);
    const showIndividuals = showsIndividualPositions(flags);
    net.setActive(
      symbols.length > 0 &&
        flags.supportPositions &&
        !showIndividuals &&
        derived,
    );
    individual.setActive(
      symbols.length > 0 &&
        flags.supportPositions &&
        showIndividuals &&
        derived,
    );
    if (
      !positionProfitVisible(display) ||
      session.state.connection.get().phase !== "ready"
    )
      return;
    const generation = session.state.connection.get().generation;
    for (const symbol of withPositions) {
      const previous = formatters.get(symbol);
      if (previous?.generation === generation && previous.mode === mode)
        continue;
      const entry: FormatterEntry = { generation, mode };
      formatters.set(symbol, entry);
      const current = () =>
        !disposed &&
        formatters.get(symbol) === entry &&
        session.state.connection.get().generation === generation;
      const load = async (): Promise<INumberFormatter | undefined> => {
        if (mode === "percentage") {
          entry.unit = "%";
          return (await session.formatters(symbol)).numeric;
        }
        if (mode === "money") {
          // Account-currency money carries no unit; instrument-currency money names its currency.
          if (session.policy.get().flags.positionPLInInstrumentCurrency) {
            const instrument = await session.symbolInfo(symbol);
            if (!current()) return undefined;
            entry.unit = instrument.currency;
          }
          return (await session.formatters(symbol)).numeric;
        }
        const instrument = await session.symbolInfo(symbol);
        if (!current()) return undefined;
        const precision = profitTickPrecision(instrument);
        if (precision === undefined)
          throw new TradingError(
            "configuration",
            "Tick formatting is unavailable.",
          );
        entry.unit = profitTickUnit(instrument);
        return session.host.numericFormatter(precision);
      };
      void load()
        .then((value) => {
          if (!current()) return;
          if (!value || typeof value.format !== "function")
            throw new TradingError(
              "configuration",
              "Profit formatting is unavailable.",
            );
          entry.formatter = value;
          symbolChanged(symbol);
        })
        .catch((cause) => {
          if (current()) onError(cause);
        });
    }
  }
  return {
    label,
    tone(kind: PositionKind, id: string, position: { readonly extra?: Record<string, unknown> }): "positive" | "negative" | "neutral" {
      const value = profitValue(kind, id, position);
      if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return "neutral";
      return value > 0 ? "positive" : "negative";
    },
    synchronize,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      for (const release of releases) release();
      net.destroy();
      individual.destroy();
      formatters.clear();
    },
  };
}
