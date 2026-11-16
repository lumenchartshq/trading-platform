import { DEFAULT_EMPTY_MESSAGE } from "./account-pages.js";
import type { AccountTableAction, AccountTableRow } from "./row-actions.js";
import { Tooltip } from "@kobalte/core/tooltip";
import { Portal } from "solid-js/web";
import { TradingPopupMount } from "../popup-mount.js";
import { formatAccountValue } from "./format-account-value.js";
import { accountCurrency, sameAccountGeneration } from "../../core/identity.js";
import { SymbolLogo } from "../symbol-logo.js";
import { createStatusCounts } from "./status-counts.js";
import { columnPriceTone, columnTooltip } from "./column-presentation.js";
import { createCsvDownloads } from "./csv-downloads.js";
import { createTableCsv } from "./table-export.js";
import { TradingError } from "../../core/errors.js";
import { TableColumns, TableStatusTabs, TableTools } from "./table-toolbar.js";
import {
  matchesTableFilter,
  readColumnChoices,
  visibleTableColumns,
  serializeColumnChoices,
} from "./table-controls.js";
import {
  OrderStatusFilter,
  Side,
  StandardFormatterName,
} from "../../contracts/broker.js";
import type { FormattedCell } from "../../compat/formatters.js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  useContext,
} from "solid-js";
import type {
  AccountManagerColumn,
  OrderStatus,
  SortingParameters,
  CustomTableElementFormatter,
  FieldRef,
} from "../../contracts/broker.js";
import type { TradingSession } from "../../core/session.js";
import type { EntityReader } from "../../core/entity-store.js";
import type { TradingEnvironment } from "../../contracts/ports.js";
import { columnValues } from "../../compat/formatters.js";
import { equalData } from "../../core/immutable.js";
import { createTableModel } from "./table-model.js";
import { TradingButton, useTradingEntity, useTradingValue } from "../primitives.js";
type Row = AccountTableRow;
const tableRowHeight = 36;
const actionIconPaths: Readonly<Record<string, string>> = {
  close: "M6 6l12 12M18 6 6 18",
  cancel: "M6 6l12 12M18 6 6 18",
  reverse: "M4 8h14m-3-3 3 3-3 3M20 16H6m3-3-3 3 3 3",
};
const editIconPath = "M5 19l3.5-.7L19 7.8 16.2 5 5.7 15.5 5 19zM14.8 6.4l2.8 2.8";
function Cell(props: {
  column: AccountManagerColumn;
  row: () => Readonly<Row> | undefined;
  session: TradingSession;
  environment: TradingEnvironment;
  custom: readonly CustomTableElementFormatter[];
  accountCurrency?: string;
}) {
  const inputs = createMemo(
    () => columnValues(props.row(), props.column.dataFields as FieldRef[]),
    undefined,
    { equals: equalData },
  );
  const custom = () =>
    props.custom.find((formatter) => formatter.name === props.column.formatter);
  const [formatters] = createResource(
    () =>
      custom() && !custom()?.isPriceFormatterNeeded
        ? undefined
        : (props.row()?.symbol || undefined),
    (symbol) => props.session.formatters(symbol),
  );
  const callbackInputs = createMemo(
    (previous: { values: unknown[]; prevValues?: unknown[] } | undefined) => ({
      values: inputs(),
      prevValues: props.column.highlightDiff ? previous?.values : undefined,
    }),
  );
  /** `isPriceFormatterNeeded` formatters also receive the row symbol's price formatter (Lumen delivery). */
  const priceFormatter = () =>
    custom()?.isPriceFormatterNeeded && !formatters.error && !formatters.loading
      ? formatters()?.price
      : undefined;
  const waitingForPriceFormatter = () =>
    Boolean(custom()?.isPriceFormatterNeeded) && !formatters.error && !priceFormatter();
  const callbackPayload = () => {
    const input = callbackInputs();
    const price = priceFormatter();
    return {
      values: [...input.values],
      prevValues: input.prevValues ? [...input.prevValues] : undefined,
      ...(price ? { priceFormatter: price } : {}),
    };
  };
  const [instrument] = createResource(
    () =>
      props.column.formatter === StandardFormatterName.FormatPriceForexSup
        ? props.row()?.symbol
        : undefined,
    (symbol) => props.session.symbolInfo(symbol),
  );
  const formatted = createMemo<FormattedCell & { unavailable?: boolean }>(
    () => {
      try {
        const provided = custom();
        if (provided) {
          if (waitingForPriceFormatter()) return { text: "" };
          return formatAccountValue(props.column.formatter, inputs(), {
            custom: provided, customInput: callbackPayload(), element: true,
          });
        }
        if (formatters.error) return { text: "—", unavailable: true };
        const services = formatters();
        if (!services)
          return {
            text: inputs()
              .map((value) => (value == null ? "" : String(value)))
              .join(" "),
          };
        return formatAccountValue(props.column.formatter, inputs(), {
          context: {
            ...services,
            ...props.environment,
            accountCurrency: props.accountCurrency,
            instrumentType: instrument.error ? undefined : instrument()?.type,
            preferSymbolName:
              props.session.features.prefer_symbol_name_over_fullname,
          },
          showZeroValues: props.column.showZeroValues !== false,
        });
      } catch {
        return { text: "—", unavailable: true };
      }
    },
  );
  const [elementError, setElementError] = createSignal(false);
  let content: HTMLSpanElement | undefined;
  createEffect(() => {
    const formatter = custom();
    setElementError(false);
    if (!content || !formatter?.formatElement) return;
    if (waitingForPriceFormatter()) return;
    try {
      const element = formatter.formatElement(callbackPayload());
      if (typeof element === "string") content.textContent = element;
      else if (element) content.replaceChildren(element);
      else content.replaceChildren();
    } catch {
      content.textContent = "—";
      setElementError(true);
    }
    onCleanup(() => content?.replaceChildren());
  });
  const symbolLogo = () => {
    if (
      props.column.formatter !== StandardFormatterName.Symbol ||
      !props.session.features.show_symbol_logo_in_account_manager
    )
      return undefined;
    const symbol = props.row()?.symbol;
    return typeof symbol === "string" ? symbol : undefined;
  };
  const tone = () => {
    if (formatted().unavailable || elementError()) return undefined;
    const input = callbackInputs();
    return (
      columnPriceTone(props.column, input.values, input.prevValues) ??
      formatted().tone
    );
  };
  const side = () => {
    if (custom() || props.column.formatter !== StandardFormatterName.Side)
      return undefined;
    const [value] = inputs();
    if (value === Side.Buy) return "buy";
    if (value === Side.Sell) return "sell";
  };
  return (
    <td
      classList={{
        "trading-cell-capitalize": props.column.isCapitalize !== false,
      }}
      style={{ "text-align": props.column.alignment ?? "left" }}
      data-column-id={props.column.id}
      data-tone={tone()}
      data-side={side()}
      title={
        formatted().unavailable || elementError()
          ? "Formatting is unavailable"
          : (formatted().message ?? columnTooltip(props.row(), props.column))
      }
    >
      <Show when={symbolLogo()}>
        {(symbol) => <SymbolLogo symbol={symbol()} enabled />}
      </Show>
      <Show
        when={custom()?.formatElement}
        fallback={
          <Show
            when={formatted().superscriptLast && formatted().text.length > 0}
            fallback={<span>{formatted().text}</span>}
          >
            <span>
              {formatted().text.slice(0, -1)}
              <sup>{formatted().text.slice(-1)}</sup>
            </span>
          </Show>
        }
      >
        <span ref={content} />
      </Show>
    </td>
  );
}

function RowAction(props: {
  action: AccountTableAction;
  row: () => Readonly<Row> | undefined;
  run(): void;
}) {
  const popupMount = useContext(TradingPopupMount);
  const disabled = () => {
    const row = props.row();
    return !row || props.action.disabled?.(row) === true;
  };
  return (
    <Tooltip placement="top" gutter={4} openDelay={250} closeDelay={0} ignoreSafeArea disabled={disabled()}>
      <Tooltip.Trigger
        as={TradingButton}
        class="trading-row-action-icon"
        aria-label={props.action.label}
        disabled={disabled()}
        onClick={props.run}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={actionIconPaths[props.action.id] ?? editIconPath} />
        </svg>
        <span class="trading-visually-hidden">{props.action.label}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal mount={popupMount}>
        <Tooltip.Content class="lumen-trading trading-row-action-tooltip">
          {props.action.tooltip ?? props.action.label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}

function TableRow(props: {
  id: string;
  reader: EntityReader<Row>;
  columns: readonly AccountManagerColumn[];
  session: TradingSession;
  environment: TradingEnvironment;
  custom: readonly CustomTableElementFormatter[];
  accountCurrency?: string;
  actions?: readonly AccountTableAction[];
  onRowAction?: (rowId: string, actionId: string) => void;
  trailingColumn: boolean;
}) {
  const row = useTradingEntity(props.reader, () => props.id);
  return (
    <tr data-row-id={props.id}>
      <For each={props.columns}>
        {(column) => (
          <Cell
            column={column}
            row={row}
            session={props.session}
            environment={props.environment}
            custom={props.custom}
            accountCurrency={props.accountCurrency}
          />
        )}
      </For>
      <Show when={props.trailingColumn}>
        <td class="trading-row-actions">
          <For each={props.actions}>
            {(action) => (
              <Show when={row() && (!action.visible || action.visible(row()!))}>
                <RowAction action={action} row={row} run={() => props.onRowAction?.(props.id, action.id)} />
              </Show>
            )}
          </For>
        </td>
      </Show>
    </tr>
  );
}
export function AccountTable(props: {
  reader: EntityReader<Row>;
  columns: readonly AccountManagerColumn[];
  session: TradingSession;
  environment: TradingEnvironment;
  custom?: readonly CustomTableElementFormatter[];
  actions?: readonly AccountTableAction[];
  onRowAction?: (rowId: string, actionId: string) => void;
  label: string;
  toolsMount?: HTMLElement;
  preferenceKey?: string;
  /** Message for an empty table without a search query. */
  emptyMessage?: string;
  initialSorting?: SortingParameters;
  statuses?: readonly OrderStatus[];
  onDependenciesChange?: (
    fields: readonly FieldRef[],
    wholeRow: boolean,
  ) => void;
}) {
  const connection = useTradingValue(props.session.state.connection),
    accounts = useTradingValue(props.session.accounts);
  const currentCurrency = createMemo(
    () =>
      accountCurrency(accounts(), connection().accountId),
  );
  const model = createTableModel(props.reader),
    ids = useTradingValue(model.ids);
  onCleanup(() => model.destroy());
  const downloads = createCsvDownloads();
  const [exporting, setExporting] = createSignal(false),
    [exportError, setExportError] = createSignal<string>();
  let active = true,
    exportController: AbortController | undefined,
    exportRoot: HTMLDivElement | undefined;
  onCleanup(() => {
    active = false;
    exportController?.abort();
    downloads.destroy();
  });
  const preferenceKey = `table:${props.preferenceKey ?? props.label}:columns`;
  const [preferenceError, setPreferenceError] = createSignal<string>();
  let persisted: string | undefined;
  try {
    persisted = props.session.preferences.get(preferenceKey);
  } catch {
    /* In-memory choices still work when storage is unavailable. */
  }
  const [choices, setChoices] = createSignal(
    readColumnChoices(persisted, props.columns),
  );
  const [query, setQuery] = createSignal("");
  const [status, setStatus] = createSignal<OrderStatus | OrderStatusFilter.All>(
    OrderStatusFilter.All,
  );
  const [statusCounts, setStatusCounts] = createSignal<
    ReadonlyMap<unknown, number>
  >(new Map());
  const [statusTotal, setStatusTotal] = createSignal(0);
  if (props.statuses)
    onCleanup(
      createStatusCounts(props.reader, (counts, total) => {
        setStatusCounts(counts);
        setStatusTotal(total);
      }),
    );
  const activeStatus = () =>
    props.statuses?.includes(status() as OrderStatus)
      ? status()
      : OrderStatusFilter.All;
  const [first, setFirst] = createSignal(0),
    [ascending, setAscending] = createSignal(true),
    [sortId, setSortId] = createSignal<string>();
  let userSorted = false;
  let scrollRoot: HTMLDivElement | undefined;
  const columns = createMemo(() =>
    visibleTableColumns(props.columns, choices()),
  );
  const filter = createMemo(
    () => ({
      query: query(),
      status: activeStatus(),
      fields: [
        "id",
        "symbol",
        ...props.columns.flatMap((column) => column.dataFields as FieldRef[]),
      ],
    }),
    undefined,
    { equals: equalData },
  );
  const dependencies = createMemo(
    () => {
      const sorted = props.columns.find((column) => column.id === sortId());
      const sortField =
        sorted?.sortProp ??
        (sorted?.dataFields as FieldRef[] | undefined)?.[0] ??
        (!userSorted ? props.initialSorting?.property : undefined);
      const fields = columns().flatMap((column) => {
        const fields = [...column.dataFields] as FieldRef[];
        if (column.tooltipProperty) fields.push(column.tooltipProperty);
        return fields;
      });
      if (sortField) fields.push(sortField);
      if (query().trim()) fields.push(...filter().fields);
      return {
        fields,
        wholeRow: columns().some((column) => !column.dataFields.length),
      };
    },
    undefined,
    { equals: equalData },
  );
  createEffect(() => {
    const value = dependencies();
    props.onDependenciesChange?.(value.fields, value.wholeRow);
  });
  onCleanup(() => props.onDependenciesChange?.([], false));
  createEffect(() => {
    const current = filter();
    model.setFilter((row) => matchesTableFilter(row, current));
    setFirst(0);
    if (scrollRoot) scrollRoot.scrollTop = 0;
  });
  createEffect(() => {
    const initial = props.initialSorting;
    if (userSorted || !initial) return;
    const column = props.columns.find((column) =>
      equalData(
        column.sortProp ?? (column.dataFields as FieldRef[])[0],
        initial.property,
      ),
    );
    setSortId(column?.id);
    setAscending(initial.asc !== false);
    model.setSort(initial.property, initial.asc !== false);
  });
  function chooseColumn(id: string, visible: boolean): void {
    const column = props.columns.find((column) => column.id === id);
    if (
      !column ||
      column.notHideable ||
      (!visible && columns().length === 1 && columns()[0].id === id)
    )
      return;
    const next = new Map(choices());
    next.set(id, visible);
    setChoices(next);
    try {
      props.session.preferences.set(
        preferenceKey,
        serializeColumnChoices(props.columns, next),
      );
      setPreferenceError(undefined);
    } catch {
      setPreferenceError("Your column choices could not be saved.");
    }
  }
  function resetColumns(): void {
    setChoices(new Map());
    try {
      props.session.preferences.remove(preferenceKey);
      setPreferenceError(undefined);
    } catch {
      setPreferenceError("Your column choices could not be saved.");
    }
  }
  const start = () => Math.min(first(), Math.max(0, ids().length - 30));
  const visible = () => ids().slice(start(), start() + 30);
  const emptyMessage = () => {
    if (query().trim()) return "No matching results.";
    return props.emptyMessage ?? DEFAULT_EMPTY_MESSAGE;
  };
  const sort = (column: AccountManagerColumn) => {
    const field = column.sortProp ?? (column.dataFields as FieldRef[])[0];
    if (!field || column.notSortable) return;
    const direction = column.id === sortId() ? !ascending() : true;
    userSorted = true;
    setSortId(column.id);
    setAscending(direction);
    model.setSort(field, direction);
  };
  async function exportCsv(): Promise<void> {
    if (exporting()) return;
    const connection = props.session.state.connection.get(),
      controller = new AbortController();
    exportController = controller;
    const assertCurrent = () => {
      const current = props.session.state.connection.get();
      if (
        !active ||
        !sameAccountGeneration(current, connection)
      )
        throw new TradingError(
          "stale-context",
          "The trading account changed. Try exporting again.",
        );
    };
    setExporting(true);
    setExportError(undefined);
    try {
      const csv = await createTableCsv({
        ids: ids(),
        reader: props.reader,
        columns: columns(),
        custom: props.custom,
        environment: props.environment,
        accountCurrency: accountCurrency(props.session.accounts.get(), connection.accountId),
        formatters: (symbol) => props.session.formatters(symbol),
        clock: props.session.clock,
        signal: controller.signal,
        assertCurrent,
      });
      assertCurrent();
      if (!exportRoot)
        throw TradingError.disposed("This table is closed.");
      const stem =
        (props.preferenceKey ?? props.label)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .slice(0, 64) || "account";
      downloads.download(exportRoot, csv, `${stem}.csv`);
    } catch (cause) {
      if (active && !controller.signal.aborted)
        setExportError(
          cause instanceof TradingError
            ? cause.message
            : "The export could not be prepared. Try again.",
        );
    } finally {
      if (active) setExporting(false);
    }
  }
  const sortDirection = (column: AccountManagerColumn) => {
    if (sortId() !== column.id) return "none";
    return ascending() ? "ascending" : "descending";
  };
  const trailingColumn = () => Boolean(props.columns.length || props.actions?.length);
  const columnCount = () => Math.max(1, columns().length + Number(trailingColumn()));
  const tools = () => (
    <TableTools
      label={props.label}
      query={query()}
      onQuery={setQuery}
      exporting={exporting()}
      canExport={ids().length > 0 && columns().length > 0}
      onExport={() => void exportCsv()}
    />
  );
  return (
    <div
      class="trading-account-table"
      ref={exportRoot}
      style={{ "--trading-table-row-height": `${tableRowHeight}px` }}
    >
      <Show when={props.toolsMount} fallback={tools()} keyed>
        {(mount) => <Portal mount={mount}>{tools()}</Portal>}
      </Show>
      <Show when={props.statuses}>
        {(statuses) => (
          <TableStatusTabs
            label={props.label}
            status={activeStatus()}
            statuses={statuses()}
            counts={statusCounts()}
            total={statusTotal()}
            onStatus={setStatus}
          />
        )}
      </Show>
      <Show when={exportError()}>
        <p role="alert" class="trading-error">
          {exportError()}
        </p>
      </Show>
      <Show when={preferenceError()}>
        <p role="alert" class="trading-error">
          {preferenceError()}
        </p>
      </Show>
      <div
        ref={scrollRoot}
        class="trading-table-scroll"
        role="region"
        aria-label={props.label}
        tabindex="0"
        onScroll={(event) =>
          setFirst(
            Math.max(0, Math.floor((event.currentTarget.scrollTop - tableRowHeight) / tableRowHeight)),
          )
        }
      >
        <table class="trading-table">
          <thead>
            <tr>
              <For each={columns()}>
                {(column) => (
                  <th
                    scope="col"
                    title={column.help}
                    aria-sort={sortDirection(column)}
                  >
                    <TradingButton
                      disabled={
                        column.notSortable ||
                        !(
                          column.sortProp ??
                          (column.dataFields as FieldRef[])[0]
                        )
                      }
                      onClick={() => sort(column)}
                    >
                      {column.label}
                    </TradingButton>
                  </th>
                )}
              </For>
              <Show when={trailingColumn()}>
                <th scope="col" class="trading-table-controls">
                  <Show when={props.columns.length}>
                    <TableColumns
                      label={props.label}
                      columns={props.columns}
                      visible={columns()}
                      onColumn={chooseColumn}
                      onResetColumns={resetColumns}
                    />
                  </Show>
                </th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <Show when={start() > 0}>
              <tr aria-hidden="true" style={{ height: `${start() * tableRowHeight}px` }}>
                <td
                  colspan={columnCount()}
                />
              </tr>
            </Show>
            <For each={visible()}>
              {(id) => (
                <TableRow
                  id={id}
                  reader={props.reader}
                  columns={columns()}
                  session={props.session}
                  environment={props.environment}
                  custom={props.custom ?? []}
                  accountCurrency={currentCurrency()}
                  actions={props.actions}
                  onRowAction={props.onRowAction}
                  trailingColumn={trailingColumn()}
                />
              )}
            </For>
            <Show when={ids().length > start() + 30}>
              <tr
                aria-hidden="true"
                style={{ height: `${(ids().length - start() - 30) * tableRowHeight}px` }}
              >
                <td
                  colspan={columnCount()}
                />
              </tr>
            </Show>
          </tbody>
        </table>
        <Show when={!ids().length}>
          <div class="trading-empty"><p>{emptyMessage()}</p></div>
        </Show>
      </div>
    </div>
  );
}
