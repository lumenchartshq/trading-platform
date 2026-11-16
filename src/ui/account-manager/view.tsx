import { userMessage } from "../../core/errors.js";
import { TradingNotificationLog } from "../notifications/log.js";
import { accountPage, accountPages } from "./account-pages.js";
import { createRowActionTracker } from "./row-action-tracker.js";
import { formatAccountValue } from "./format-account-value.js";

import { TradingTabs } from "../tabs.js";
import { accountTypeChoices, accountsOfType, type AccountKind } from "../../core/account-types.js";
import { TradingSelect } from "../select.js";
import { createPositionEstimates } from "../../core/position-estimates.js";
import { createEffect, createMemo, createResource, on } from "solid-js";

import type { CustomTableElementFormatter } from "../../contracts/broker.js";
import { createStatusCounts } from "./status-counts.js";
import {
  RowContextMenu,
  normalizeMenuItems,
} from "./context-menu.js";
import { OrderStatus as Status } from "../../contracts/broker.js";
import { createAccountRowActions, type AccountTableRow, type PositionRowAction } from "./row-actions.js";
import {
  createPositionTableReader,
  needsPositionProfit,
} from "./position-reader.js";

import { For, Show, Switch, Match, createSignal, onCleanup } from "solid-js";
import type { AccountManagerSummaryField } from "../../contracts/broker.js";
import type { TradingEnvironment } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import type { EntityReader } from "../../core/entity-store.js";
import { TradingButton, useTradingValue, useWatchedValue, useCurrentAccount } from "../primitives.js";
import {
  CustomAccountPage,
  createPageControllers,
  subscribePageCount,
  type CustomTableController,
} from "./custom-page.js";
import { AccountTable } from "./table.js";
/** Summary values use their declared standard or custom formatter; broker text is never parsed as HTML. */
function SummaryField(props: {
  field: AccountManagerSummaryField;
  session: TradingSession;
  environment: TradingEnvironment;
  custom?: readonly CustomTableElementFormatter[];
  currency?: string;
}) {
  const value = useWatchedValue(props.field.wValue);
  const [formatters] = createResource(
    () => props.field.formatter,
    () => props.session.formatters(""),
  );
  const text = () => {
    const current = value();
    if (current === undefined) return "Unavailable";
    try {
      const custom = props.custom?.find(
        (formatter) => formatter.name === props.field.formatter,
      );
      if (custom) {
        return formatAccountValue(props.field.formatter, [current], { custom }).text;
      }
      // Reading an errored resource throws; plain fields never need formatter services.
      if (!props.field.formatter || formatters.error) return String(current);
      const services = formatters();
      if (!services) return String(current);
      return formatAccountValue(props.field.formatter, [current], {
        context: { ...services, ...props.environment, accountCurrency: props.currency },
        showZeroValues: false,
      }).text;
    } catch {
      return "—";
    }
  };
  return (
    <div title={props.field.informerMessage}>
      <dt>{props.field.text}</dt>
      <dd>{text()}</dd>
    </div>
  );
}
/** The Orders page count is the live working set, as in the reference terminal. */
const workingStatuses = [Status.Placing, Status.Inactive, Status.Working];
export function AccountManagerView(props: {
  session: TradingSession;
  environment: TradingEnvironment;
  onOrderAction?: (id: string) => void;
  onPositionAction?: (
    id: string,
    individual: boolean,
    action: PositionRowAction,
  ) => Promise<void>;
  onClose?(): void;
  collapsed: boolean;
  maximized: boolean;
  canTrade: boolean;
  onToggle(): void;
  onMaximize(): void;
  onTrade(initiator: HTMLElement): void;
  onDepth(): void;
}) {
  let resetRows = () => {};
  const connection = useTradingValue(props.session.state.connection, (previous, next) => {
      if (previous.generation !== next.generation) resetRows();
    }),
    policy = useTradingValue(props.session.policy),
    symbolOptions = useTradingValue(props.session.symbolOptionsRevision),
    accounts = useTradingValue(props.session.accounts),
    notifications = useTradingValue(props.session.notifications);
  const [needsProfit, setNeedsProfit] = createSignal(false);
  const netEstimates = createPositionEstimates(
    props.session,
    props.session.state.positions,
  );
  const individualEstimates = createPositionEstimates(
    props.session,
    props.session.state.individualPositions,
    true,
  );
  const positions = createPositionTableReader(
    props.session.state.positions,
    props.session.state.tablePL,
    false,
    netEstimates.reader,
  );
  const individuals = createPositionTableReader(
    props.session.state.individualPositions,
    props.session.state.individualTablePL,
    true,
    individualEstimates.reader,
  );
  createEffect(() => {
    const enabled = policy().flags.supportPLUpdate;
    positions.setEnabled(enabled);
    individuals.setEnabled(enabled);
    netEstimates.setActive(
      !enabled &&
        needsProfit() &&
        !props.collapsed &&
        tab() === "positions" &&
        policy().flags.supportPositions,
    );
    individualEstimates.setActive(
      !enabled &&
        needsProfit() &&
        !props.collapsed &&
        tab() === "individual" &&
        policy().flags.supportPositionNetting,
    );
  });
  onCleanup(() => {
    positions.destroy();
    individuals.destroy();
    netEstimates.destroy();
    individualEstimates.destroy();
  });
  const [selectedTab, setTab] = createSignal<string>(),
    [error, setError] = createSignal<string>(),
    [actionStatus, setActionStatus] = createSignal<string>(),
    [pendingRows, setPendingRows] = createSignal<ReadonlySet<string>>(
      new Set(),
    );
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const tracker = createRowActionTracker({
    current: connection, pending: value => setPendingRows(value),
    error: value => setError(value), status: value => setActionStatus(value),
  });
  onCleanup(() => tracker.destroy());
  resetRows = () => tracker.reset();
  const metadata = () => {
    connection();
    return props.session.accountManagerInfo;
  };
  const [allSummary, setAllSummary] = createSignal(false);
  // Rows the broker sent that could not be read (quarantined by the last read of each table).
  const datasetStatuses = [
    useTradingValue(props.session.datasets.orders),
    useTradingValue(props.session.datasets.history),
    useTradingValue(props.session.datasets.positions),
    useTradingValue(props.session.datasets.individualPositions),
  ];
  const unreadRows = createMemo(() =>
    datasetStatuses.reduce((sum, status) => sum + (status().status === "ready" ? (status().warnings ?? 0) : 0), 0),
  );
  /** When a broker marks default fields, only those show until the user asks for more. */
  const summaryFields = () => {
    const fields = metadata()?.summary ?? [];
    if (allSummary() || !fields.some((field) => field.isDefault)) return fields;
    return fields.filter((field) => field.isDefault);
  };
  const hiddenSummaryCount = () => {
    const fields = metadata()?.summary ?? [];
    if (!fields.some((field) => field.isDefault)) return 0;
    return fields.filter((field) => !field.isDefault).length;
  };
  const selected = useCurrentAccount(props.session);
  async function changeAccount(value: string) {
    setError(undefined);
    try {
      await props.session.commands.selectAccount(value);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The account could not be changed.",
      );
    }
  }
  /** Default items are this page's row actions; a broker may replace them through contextMenuActions. */
  function rowMenuItems(
    commands: ReturnType<typeof rowActions.bind>,
    rowId: string,
    event: MouseEvent,
  ) {
    const defaults = commands.menu(rowId);
    if (!defaults) return undefined;
    const provider = metadata()?.contextMenuActions;
    if (!provider) return defaults.length ? { initial: defaults } : undefined;
    return {
      load: (async () => {
        try {
          return normalizeMenuItems(await provider.call(metadata(), event, defaults.slice()));
        } catch {
          return defaults;
        }
      })().then(items => commands.isCurrent() ? items : []),
    };
  }
  const [tabCounts, setTabCounts] = createSignal<Record<string, number>>({});
  const countInto = (id: string, count: (counts: ReadonlyMap<unknown, number>, total: number) => number) =>
    (counts: ReadonlyMap<unknown, number>, total: number) =>
      setTabCounts((previous) => ({ ...previous, [id]: count(counts, total) }));
  onCleanup(
    createStatusCounts(
      props.session.state.orders,
      countInto("orders", (counts) =>
        workingStatuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0),
      ),
    ),
  );
  onCleanup(createStatusCounts(positions.reader, countInto("positions", (_counts, total) => total)));
  /**
   * Pages that ask for a tab counter load eagerly; their controllers are shared with the rendered page.
   * Rebuilt once per connection generation (account or reconnect), not on every phase change.
   */
  const [pageControllers, setPageControllers] = createSignal<ReadonlyMap<string, ReadonlyMap<string, CustomTableController>>>(
    new Map(),
  );
  // Each hydration assigns a fresh metadata object after the connection carries its account; phase writes
  // in between reuse the same object, so only a new object (reconnect, account switch, refresh) rebuilds.
  const managerInfo = createMemo(() => metadata(), undefined, { equals: (a, b) => a === b });
  createEffect(
    on(
      managerInfo,
      (info) => {
        const controllers = new Map<string, ReadonlyMap<string, CustomTableController>>();
        for (const page of info?.pages ?? []) {
          if (!page.displayCounterInTab) continue;
          const tables = createPageControllers(page, props.session);
          controllers.set(page.id, tables);
          onCleanup(
            subscribePageCount(tables, (count) =>
              setTabCounts((previous) => ({ ...previous, [`custom:${page.id}`]: count })),
            ),
          );
          onCleanup(() => tables.forEach((controller) => controller.destroy()));
        }
        setPageControllers(controllers);
      },
    ),
  );
  onCleanup(createStatusCounts(individuals.reader, countInto("individual", (_counts, total) => total)));
  const tabs = createMemo(() => [
    ...accountPages.filter(page => page.enabled(policy().flags, props.session.features))
      .map(page => ({ id: page.id, title: page.title(policy().flags) })),
    ...(metadata()?.pages ?? []).map(page => ({ id: `custom:${page.id}`, title: page.title })),
  ]);
  const tab = () => tabs().find((page) => page.id === selectedTab())?.id ?? tabs()[0].id;
  const activePage = () => accountPage(tab());
  const readers = {
    positions: positions.reader, individualPositions: individuals.reader,
    history: props.session.state.history, orders: props.session.state.orders,
  };
  const reader = () => readers[activePage().reader] as EntityReader<AccountTableRow>;
  const columns = () => activePage().columns(metadata());
  const initialSorting = () => activePage().sorting?.(metadata());
  const rowActions = createAccountRowActions({
    session: props.session,
    connection,
    pendingRows,
    policy,
    symbolOptions,
    tracker,
    get onOrderAction() { return props.onOrderAction; },
    get onPositionAction() { return props.onPositionAction; },
  });
  const statusLabel = () => {
    const phase = connection().phase;
    if (phase === "ready") return "Connected";
    if (phase === "hydrating") return "Refreshing";
    if (phase === "switching") return "Changing account";
    if (phase === "initializing") return "Connecting";
    if (phase === "disconnected") return "Disconnected";
    if (phase === "disposed") return "Closed";
    return "Unavailable";
  };
  const accountTypes = () =>
    accountTypeChoices(accounts(), policy().flags.supportDemoLiveSwitcher);
  const currentAccountType = () => selected()?.type;
  const pickerAccounts = () =>
    accountsOfType(
      accounts(),
      accountTypes().length > 0 ? currentAccountType() : undefined,
    );
  const switchAccountType = (type: AccountKind) => {
    if (currentAccountType() === type) return;
    const next = accountsOfType(accounts(), type)[0];
    if (next) void changeAccount(next.id as string);
  };
  const [tableToolsMount, setTableToolsMount] = createSignal<HTMLDivElement>();
  const readable = () =>
    ["ready", "disconnected", "error", "hydrating"].includes(
      connection().phase,
    ) && !!metadata();
  return (
    <section data-ui="trading-accounts" aria-label="Account Manager">
      <header class="trading-account-rail" aria-label="Account Manager bar">
        <TradingButton
          class="trading-account-caption"
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
        >
          Account Manager
        </TradingButton>
        <Show when={props.session.features.order_panel}>
          <TradingButton
            class="trading-account-trade"
            disabled={!props.canTrade || connection().phase !== "ready"}
            onClick={(event) => {
              event.currentTarget.focus();
              props.onTrade(event.currentTarget);
            }}
          >
            Trade
          </TradingButton>
        </Show>
        <Show when={props.session.features.dom_widget}>
          <TradingButton
            class="trading-account-trade"
            disabled={!props.canTrade || connection().phase !== "ready" || !policy().dom}
            onClick={() => props.onDepth()}
          >
            Market depth
          </TradingButton>
        </Show>
        <span class="trading-account-rail-spacer" />
        <TradingButton
          class="trading-icon-button"
          aria-label={
            props.collapsed
              ? "Expand Account Manager"
              : "Collapse Account Manager"
          }
          onClick={props.onToggle}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={props.collapsed ? "m6 14 6-5 6 5" : "M5 17h14"} />
          </svg>
        </TradingButton>
        <TradingButton
          class="trading-icon-button"
          aria-label={
            props.maximized
              ? "Restore Account Manager"
              : "Maximize Account Manager"
          }
          onClick={props.onMaximize}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d={
                props.maximized
                  ? "M8 4v4H4m12-4v4h4M4 16h4v4m8 0v-4h4"
                  : "M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"
              }
            />
          </svg>
        </TradingButton>
      </header>
      <Show when={!props.collapsed}>
        <div class="trading-account-content">
          <div class="trading-account-overview">
            <header class="trading-panel-header">
              <Show when={metadata()?.accountTitle}>
                {(title) => <strong>{title()}</strong>}
              </Show>
              <div class="trading-actions">
                <Show when={accountTypes().length > 0}>
                  <div
                    class="trading-segmented"
                    role="group"
                    aria-label="Account type"
                  >
                    <For each={accountTypes()}>
                      {(type) => (
                        <TradingButton
                          aria-pressed={currentAccountType() === type}
                          disabled={
                            connection().phase === "switching" ||
                            connection().phase === "hydrating"
                          }
                          onClick={() => switchAccountType(type)}
                        >
                          {type === "demo" ? "Demo" : "Live"}
                        </TradingButton>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="trading-account-select">
                  <TradingSelect
                    label="Trading account"
                    disabled={
                      connection().phase === "switching" ||
                      connection().phase === "hydrating"
                    }
                    value={connection().accountId}
                    options={pickerAccounts().map((account) => ({
                      value: account.id as string,
                      label: account.name,
                    }))}
                    onChange={(value) => {
                      void changeAccount(value);
                    }}
                  />
                </div>
              </div>
              <Show when={props.onClose}>
                {(close) => (
                  <TradingButton aria-label="Hide Account Manager" onClick={() => close()()}>
                    Hide
                  </TradingButton>
                )}
              </Show>
            </header>
            <div class="trading-account-summary">
                <Show when={connection().phase !== "ready"}>
                  <span role="status" data-state={connection().phase}>{statusLabel()}</span>
                </Show>
              <span>
                {[selected()?.currencySign, selected()?.currency]
                  .filter(Boolean)
                  .join(" ")}
              </span>
              <dl>
                <For each={summaryFields()}>
                  {(field) => (
                    <SummaryField
                      field={field}
                      session={props.session}
                      environment={props.environment}
                      custom={metadata()?.customFormatters}
                      currency={selected()?.currency}
                    />
                  )}
                </For>
              </dl>
              <Show when={hiddenSummaryCount()}>
                <TradingButton
                  aria-pressed={allSummary()}
                  onClick={() => setAllSummary(!allSummary())}
                >
                  {allSummary() ? "Fewer details" : "More details"}
                </TradingButton>
              </Show>
            </div>
          </div>
          <Show
            when={
              connection().phase === "disconnected" ||
              connection().phase === "error"
            }
          >
            <div class="trading-status">
              <Show when={connection().notice?.heading}>
                {(heading) => <strong>{heading()}</strong>}
              </Show>
              <p>
                {connection().error ??
                  connection().notice?.message ??
                  "The connection is unavailable. Last confirmed data is shown."}
              </p>
              <Show when={connection().notice?.additionalInfo}>
                {(info) => <p class="trading-muted">{info()}</p>}
              </Show>
              <TradingButton
                onClick={() => {
                  void props.session
                    .refresh()
                    .catch((cause) =>
                      setError(
                        userMessage(cause, "Try again."),
                      ),
                    );
                }}
              >
                Refresh
              </TradingButton>
            </div>
          </Show>
          <Show when={error()}>
            <p role="alert" class="trading-error">
              {error()}
            </p>
          </Show>
          <Show when={actionStatus()}>
            <p role="status">{actionStatus()}</p>
          </Show>
          <Show when={unreadRows()}>
            {(count) => (
              <p role="status" class="trading-muted" data-ui="account-unread-rows">
                {unreadRowsText(count())}
              </p>
            )}
          </Show>
          <div class="trading-account-page-bar">
            <TradingTabs
              class="trading-account-tabs"
              label="Account pages"
              value={tab()}
              tabs={tabs().map((item) => ({
                value: item.id,
                label: (
                  <>
                    {item.title}
                    <Show when={tabCounts()[item.id]}>
                      {(count) => (
                        <>
                          {" "}
                          <span class="trading-tab-count">{count()}</span>
                        </>
                      )}
                    </Show>
                  </>
                ),
              }))}
              onChange={setTab}
            />
            <div ref={setTableToolsMount} />
          </div>
          <Show
            when={readable()}
            fallback={<p role="status">Loading account information…</p>}
          >
            <Switch>
              <Match when={tab() === "notifications"}>
                <TradingNotificationLog entries={notifications()} environment={props.environment} />
              </Match>
              <Match when={!tab().startsWith("custom:")}>
                <Show when={`${tab()}:${connection().generation}`} keyed>
                  {identity => {
                    const source = reader();
                    const kind = activePage().actions;
                    let mounted = true;
                    onCleanup(() => { mounted = false; });
                    const commands = rowActions.bind(source, kind, () =>
                      mounted && active && !props.collapsed &&
                      identity === `${tab()}:${connection().generation}`);
                    return (
                      <RowContextMenu items={(id, event) => rowMenuItems(commands, id, event)}>
                        <AccountTable
                          reader={source}
                          columns={columns()}
                          session={props.session}
                          environment={props.environment}
                          custom={metadata()?.customFormatters}
                          actions={commands.actions()}
                          onRowAction={commands.run}
                          onDependenciesChange={(fields, wholeRow) =>
                            setNeedsProfit(needsPositionProfit(fields, wholeRow))
                          }
                          preferenceKey={tab()}
                          emptyMessage={activePage().emptyMessage}
                          toolsMount={tableToolsMount()}
                          initialSorting={initialSorting()}
                          statuses={activePage().statuses?.(metadata())}
                          label={
                            tabs().find((item) => item.id === tab())?.title ??
                            "Account rows"
                          }
                        />
                      </RowContextMenu>
                    );
                  }}
                </Show>
              </Match>
              <Match when={tab().startsWith("custom:")}>
            <Show
              when={metadata()?.pages.find(
                (page) => `custom:${page.id}` === tab(),
              )}
              keyed
            >
              {(page) => (
                <CustomAccountPage
                  page={page}
                  controllers={pageControllers().get(page.id)}
                  session={props.session}
                  environment={props.environment}
                  custom={metadata()?.customFormatters}
                />
              )}
            </Show>
              </Match>
            </Switch>
          </Show>
        </div>
      </Show>
    </section>
  );
}
/** Plain wording for rows the broker sent that could not be shown. */
export function unreadRowsText(count: number): string {
  return count === 1
    ? "1 row from your broker could not be shown."
    : `${count} rows from your broker could not be shown.`;
}
