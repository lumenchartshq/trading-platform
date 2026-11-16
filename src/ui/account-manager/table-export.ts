import { formatAccountValue } from "./format-account-value.js";
import type { AccountManagerColumn, CustomTableElementFormatter, FieldRef } from "../../contracts/broker.js";
import type {
  TradingClock,
  TradingEnvironment,
} from "../../contracts/ports.js";
import type { EntityReader } from "../../core/entity-store.js";
import type { TableFormatContext } from "../../compat/formatters.js";
import { columnValues } from "../../compat/formatters.js";
import { TradingError } from "../../core/errors.js";
type Row = { id: string; symbol?: string; [key: string]: unknown };
type Formatters = Pick<
  TableFormatContext,
  "price" | "quantity" | "numeric" | "integer" | "variable"
>;
export const tableExportLimits = Object.freeze({
  rows: 10000,
  cells: 200000,
  milliseconds: 30000,
  concurrency: 8,
});
export function csvCell(value: string): string {
  // CSV quoting alone does not stop a spreadsheet from evaluating a cell as a formula.
  const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+\-]?\d+)?$/u.test(value);
  const safe =
    !numeric && /^[\s\u0000-\u001f\uFEFF]*[=+\-@]/u.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export async function createTableCsv(options: {
  readonly ids: readonly string[];
  readonly reader: EntityReader<Row>;
  readonly columns: readonly AccountManagerColumn[];
  readonly custom?: readonly CustomTableElementFormatter[];
  readonly environment: Pick<TradingEnvironment, "locale" | "timezone">;
  readonly accountCurrency?: string;
  readonly formatters: (symbol: string) => Promise<Formatters>;
  readonly clock: TradingClock;
  readonly signal?: AbortSignal;
  readonly assertCurrent: () => void;
}): Promise<string> {
  const { ids, clock, signal } = options;
  if (
    ids.length > tableExportLimits.rows ||
    (ids.length + 1) * options.columns.length > tableExportLimits.cells
  )
    throw new TradingError(
      "invalid-input",
      "Too many rows or columns to export. Narrow the table first.",
    );
  if (!options.columns.length)
    throw new TradingError(
      "invalid-input",
      "Choose a column before exporting.",
    );
  const columns = options.columns.map((column) => ({
    label: column.label,
    formatter: column.formatter,
    showZeroValues: column.showZeroValues,
    dataFields: (column.dataFields as FieldRef[]).map((field) =>
      Array.isArray(field) ? [...field] : field,
    ),
  }));
  const environment = {
    locale: options.environment.locale,
    timezone: options.environment.timezone,
  };
  const accountCurrency = options.accountCurrency;
  const assertCurrent = () => {
    if (signal?.aborted)
      throw new TradingError("stale-context", "This export was stopped.");
    options.assertCurrent();
  };
  assertCurrent();
  // Readers expose immutable rows. Holding references captures the click-time snapshot
  // without copying large extra fields or allowing later pushes to mix into the file.
  const rows = ids.map((id) => {
    const row = options.reader.get(id);
    if (!row)
      throw new TradingError(
        "stale-context",
        "The table changed. Try exporting again.",
      );
    return row;
  });
  const custom = new Map(
    (options.custom ?? []).map((formatter) => [
      formatter.name as string,
      {
        formatText: formatter.formatText.bind(formatter),
        isPriceFormatterNeeded: formatter.isPriceFormatterNeeded === true,
      },
    ]),
  );
  const needsFormatters = columns.some((column) => {
    const provided = custom.get(column.formatter ?? "");
    return !provided || provided.isPriceFormatterNeeded;
  });
  let stop!: (cause: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = reject;
  });
  void stopped.catch(() => {});
  const abort = () =>
    stop(new TradingError("stale-context", "This export was stopped."));
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = clock.setTimeout(
    () =>
      stop(
        new TradingError(
          "broker-unavailable",
          "The export took too long. Narrow the table and try again.",
        ),
      ),
    tableExportLimits.milliseconds,
  );
  const lines = new Array<string>(rows.length);
  let next = 0,
    active = true;
  try {
    const worker = async () => {
      while (next < rows.length) {
        const index = next++,
          row = rows[index];
        assertCurrent();
        const services = needsFormatters
          ? await Promise.race([options.formatters(row.symbol ?? ""), stopped])
          : undefined;
        if (!active) return;
        assertCurrent();
        const cells = columns.map((column) => {
          const values = columnValues(row, column.dataFields as FieldRef[]),
            provided = custom.get(column.formatter ?? "");
          const text = formatAccountValue(column.formatter, values, {
            custom: provided,
            customInput: {
              values: [...values],
              ...(provided?.isPriceFormatterNeeded && services ? { priceFormatter: services.price } : {}),
            },
            context: services ? { ...services, ...environment, accountCurrency } : undefined,
            showZeroValues: column.showZeroValues !== false,
          }).text;
          return csvCell(text);
        });
        lines[index] = cells.join(",");
      }
    };
    await Promise.race([
      Promise.all(
        Array.from(
          { length: Math.min(tableExportLimits.concurrency, rows.length) },
          worker,
        ),
      ),
      stopped,
    ]);
    assertCurrent();
    return `\uFEFF${columns.map((column) => csvCell(column.label)).join(",")}\r\n${lines.join("\r\n")}\r\n`;
  } finally {
    active = false;
    clock.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    stop(TradingError.disposed("The export is finished."));
  }
}
