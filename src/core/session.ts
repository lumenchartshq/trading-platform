import { userMessage } from "./errors.js";
import { instrumentPointValue } from "./financial-rules.js";
import { createChartOrderEdit } from "./chart-order-edit.js";
import { preferencesKey } from "./preferences-key.js";
import { AccountLifecycle } from "./account-lifecycle.js";
import { SymbolCatalog } from "./symbol-catalog.js";
import { createCloseFlow } from "./close-flow.js";

import type { ConnectionPhase } from "./trading-state.js";
import type { ActionMetaInfo, InstrumentInfo, Order, OrderTicketSettings, PreOrder, TradeContext } from "../contracts/broker.js";
import type { TradingChartBinding, TradingDiagnostic } from "../contracts/ports.js";
import type { LeverageRequest } from "./leverage-commands.js";

import { OrderNotice, watchOrderNotifications } from "./order-notifications.js";
import { createDefaultExecutionSound } from "./execution-sound.js";

import { normalizeTradability, type Tradability } from "./tradability.js";
import { createDisplayPreferences } from "./display-preferences.js";

import { createExecutionDemand } from "./execution-demand.js";
import { debugBrokerSide } from "./broker-debug.js";
import { orderEditability } from "./order-modification.js";
import { modificationParentAvailable } from "./modification-context.js";
import { resolveTradingFeatures } from "./features.js";

import type { AccountManagerInfo, AccountMetainfo, IBrokerTerminal, OrderDurationMetaInfo, SingleBrokerMetaInfo } from "../contracts/broker.js";
import type { TradingSessionOptions } from "./session-types.js";
import { createSessionDemand } from "../market-data/session-demand.js";
import { createTradingHost } from "../compat/host.js";
import { CommandCoordinator } from "./command-coordinator.js";
import { createTradingState } from "./trading-state.js";
import { TradingCommands } from "./trading-commands.js";
import { createAccountDatasets } from "./account-datasets.js";
import { ValueStore } from "./value-store.js";
import { DisposalScope } from "./disposal.js";
import { DialogCoordinator } from "./dialog-coordinator.js";
import { deferred } from "./deferred.js";
import { TradingError } from "./errors.js";

import { entityReader, valueReader } from "./readers.js";
import { systemClock } from "./clock.js";
import { ReadCoordinator } from "./read-coordinator.js";
import { normalizeBrokerConfig } from "./capabilities.js";
import { createCapabilityPolicy } from "./capability-policy.js";
import { createProtectionNotifications } from "./protection-notifications.js";
import { NotificationLog } from "./notification-log.js";

/** One headless session owns exactly one broker, independent of chart count or UI mounts. */
export function createTradingSession(options: TradingSessionOptions) {
  const features = resolveTradingFeatures(
    options.enabledFeatures,
    options.disabledFeatures,
  );
  const hostOptions = {
    ...options,
    settingsKey: options.settingsKey ?? crypto.randomUUID(),
    requireConfirmation:
      options.requireConfirmation || features.always_require_order_confirmation,
  };
  const clock = options.clock ?? systemClock;
  const scope = new DisposalScope();
  const displayPreferences = createDisplayPreferences(
    options.settings,
    hostOptions.settingsKey,
    options.displaySettings,
  );
  scope.own(() => displayPreferences.destroy());
  const privacyMode = new ValueStore<boolean>(false);
  scope.own(() => privacyMode.destroy());
  const hostPrivacy = options.privacyMode;
  if (hostPrivacy !== undefined) {
    if (typeof hostPrivacy?.get !== "function" || typeof hostPrivacy.subscribe !== "function")
      throw new TradingError("configuration", "privacyMode must be a readable value.");
    privacyMode.set(hostPrivacy.get() === true);
    scope.own(hostPrivacy.subscribe((value) => privacyMode.set(value === true)));
  }
  const ticketSettings = new ValueStore<
    OrderTicketSettings
  >({ showRelativePriceControl: false, showOrderPreview: true });
  scope.own(() => ticketSettings.destroy());
  const state = createTradingState();
  const completion = deferred<void>();
  const brokerReady = deferred<IBrokerTerminal>();
  const dialogs = new DialogCoordinator();
  const deadlines = {
    command: options.deadlines?.command ?? 10000,
    reconcile: options.deadlines?.reconcile ?? 60000,
    accountSwitch: options.deadlines?.accountSwitch ?? 10000,
    read: options.deadlines?.read ?? 15000,
    snapshot: options.deadlines?.snapshot ?? 15000,
  };
  const coordinator = new CommandCoordinator(clock, deadlines.command, deadlines.reconcile);
  const notifications = new NotificationLog(() => clock.now());
  const notificationsEnabled =
    features.trading_notifications || features.show_trading_notifications_history;
  const accountReady = () => state.connection.get().phase === "ready";
  const notificationsLive = () => accountReady() && notificationsEnabled;
  const protectionNotifications = createProtectionNotifications(
    notifications,
    () => clock.now(),
    () => {
      const { accountId, generation } = state.connection.get();
      return accountId === undefined ? undefined : { accountId, generation };
    },
    notificationsLive,
  );
  const accounts = new ValueStore<readonly AccountMetainfo[]>([]);
  const config: SingleBrokerMetaInfo = normalizeBrokerConfig(options.brokerConfig);
  const defaultSound = options.sound ? undefined : createDefaultExecutionSound();
  if (defaultSound) scope.own(() => defaultSound.close());
  const sound = options.sound ?? defaultSound!;
  scope.own(
    watchOrderNotifications(
      state.orders,
      accountReady,
      (Array.isArray(config.customNotificationFields)
        ? config.customNotificationFields
        : []
      ).filter((field): field is string => typeof field === "string"),
      (notification, order) => {
        if (notificationsEnabled) protectionNotifications.order(notification, order);
        if (notification.event === OrderNotice.Executed && displayPreferences.state.get().executionSound === true) {
          try {
            sound.playExecution();
          } catch {
            /* A failing sound port never fails the order update. */
          }
        }
      },
    ),
  );
  let broker: IBrokerTerminal | undefined;
  let managerInfo: AccountManagerInfo | undefined;
  const account: AccountLifecycle = new AccountLifecycle({
    state, accounts, clock, completion, brokerReady,
    switchDeadline: deadlines.accountSwitch,
    readDeadline: deadlines.read,
    broker: () => getBroker(),
    read: (load, epoch) => read(load, epoch),
    phase: (phase, status, error) => setPhase(phase, status, error),
    flags: () => policy.get().flags,
    updatePolicy: () => updatePolicy(),
    managerInfo: value => { managerInfo = value; },
    beginSnapshots: flags => accountDatasets.beginSnapshots(flags),
    resume: () => { demand.resume(); if (policy.get().flags.supportExecutions) executionDemand.resume(); },
    suspend: clear => { installedCommands?.invalidatePreviews(); executionDemand.suspend(clear); demand.suspend(); },
    invalidateReads: () => reads.invalidate(),
    invalidateState: clear => {
      catalog.invalidate();
      for (const dataset of datasets) dataset.invalidate(clear);
      coordinator.suspend();
      dialogs.cancelAll();
      if (clear) state.clearAccount();
    },
    changed: () => coordinator.changed(),
    disposeResources: () => scope.destroy(),
  });
  const catalog: SymbolCatalog = new SymbolCatalog({
    ready: brokerReady.promise, fallbackFormatters: options.formatters,
    alive: () => account.alive, generation: () => account.generation,
    broker: () => getBroker(), read: (load, epoch) => read(load, epoch),
    loaded: (symbol, instrument) => reportMissingPointValue(symbol, instrument),
  });
  /** Symbols already reported, so a repeated lookup does not repeat the diagnostic. */
  const pointValueReported = new Set<string>();
  /**
   * Money P&L in the instrument currency needs the contract's point value. A futures instrument without one would
   * otherwise only show unavailable amounts on the chart, so the adapter gap is reported once per symbol.
   */
  function reportMissingPointValue(symbol: string, instrument: InstrumentInfo): void {
    if (pointValueReported.has(symbol) || !symbolPolicy(symbol).flags.positionPLInInstrumentCurrency) return;
    if (instrumentPointValue(instrument) !== undefined) return;
    pointValueReported.add(symbol);
    diagnostic({
      source: "instrument",
      method: "symbolInfo",
      entityId: symbol,
      message: `${symbol} has no point value (bigPointValue), so profit and loss in its own currency cannot be estimated.`,
    });
  }
  scope.own(() => catalog.destroy());
  const capabilities = createCapabilityPolicy({
    config,
    catalog,
    context: () => ({
      broker,
      extensions: options.extensions,
      domFeature: features.dom_widget,
      quoteMethods: options.marketDataCapabilities?.quotes ?? true,
      depthMethods: options.marketDataCapabilities?.depth ?? true,
    }),
  });
  scope.own(() => capabilities.destroy());
  const policy = capabilities.policy;
  const symbolPolicy = capabilities.symbolPolicy;
  const getBroker = () => {
    if (!broker)
      throw TradingError.brokerUnavailable();
    return broker;
  };
  const accountDatasets = createAccountDatasets({
    state,
    broker: getBroker,
    clock,
    diagnostic: (value) => diagnostic(value),
    deadline: deadlines.snapshot,
    historyLimit: options.historyLimit,
  });
  const { orders, history, positions, individualPositions } = accountDatasets;
  const datasets = accountDatasets.all;
  const updatePolicy = () => {
    if (!account.alive) return;
    const next = capabilities.resolveAccount();
    if (!next.flags.supportExecutions && policy.get().flags.supportExecutions)
      executionDemand.suspend();
    policy.set(next);
    if (
      next.flags.supportExecutions &&
      state.connection.get().phase === "ready"
    )
      executionDemand.resume();
  };
  const setPhase = (
    phase: Exclude<ConnectionPhase, "initializing">,
    status = state.connection.get().status,
    error?: string,
  ) =>
    state.connection.set({
      ...state.connection.get(),
      phase,
      status,
      generation: account.generation,
      error,
      notice: undefined,
    });
  const reads = new ReadCoordinator(clock, () => account.generation, deadlines.read);
  scope.own(() => reads.destroy());
  const read = <T>(load: () => T | Promise<T>, epoch: number = account.generation): Promise<T> =>
    reads.read(load, epoch);
  /**
   * One broker `isTradable` read per symbol and account, shared by the chart's Buy/Sell controls
   * and its menus. A new account generation clears the cache; failed reads are not kept.
   */
  const tradabilityCache = new Map<string, Promise<Tradability>>();
  let tradabilityGeneration = -1;
  scope.own(() => tradabilityCache.clear());
  /** Normalized broker tradability with reason, heading, short reason and an optional solution. */
  async function tradability(symbol: string): Promise<Tradability> {
    await brokerReady.promise;
    if (tradabilityGeneration !== account.generation) {
      tradabilityCache.clear();
      tradabilityGeneration = account.generation;
    }
    const cached = tradabilityCache.get(symbol);
    if (cached) return cached;
    const pending = read(() => getBroker().isTradable(symbol)).then(normalizeTradability);
    tradabilityCache.set(symbol, pending);
    pending.catch(() => {
      if (tradabilityCache.get(symbol) === pending) tradabilityCache.delete(symbol);
    });
    return pending;
  }
  const symbolInfo = catalog.info;
  const demand = createSessionDemand(
    options.marketData,
    state,
    getBroker,
    symbolInfo,
    (cause) => {
      if (account.alive)
        host.showNotification(
          "Trading information unavailable",
          userMessage(cause, "Try again."),
        );
    },
  );
  const executionDemand = createExecutionDemand(
    state.executions,
    (symbol) => getBroker().executions(symbol),
    clock,
    (cause) => {
      if (account.alive)
        host.showNotification(
          "Executions unavailable",
          userMessage(cause, "Try again."),
        );
    },
    deadlines.snapshot,
  );
  const debugLog = options.debugLogger ?? ((message: string, ...details: unknown[]) => console.debug(message, ...details));
  /** Dropped broker input: never thrown into the adapter; logged with `debugBroker`, reported to `diagnostics`. */
  const diagnostic = (value: TradingDiagnostic) => {
    if (!account.alive) return;
    if (options.debugBroker) debugLog(`[trading] dropped ${value.source} ${value.method}`, value);
    try {
      options.diagnostics?.(value);
    } catch {
      /* A failing diagnostics port cannot affect broker input. */
    }
  };
  const refresh = account.refresh, requestRefresh = account.requestRefresh, selectAccount = account.selectAccount;
  let settingsOpener: (() => boolean) | undefined;
  const host = createTradingHost(hostOptions, {
    openSettings: () => {
      try {
        return settingsOpener?.() ?? false;
      } catch {
        return false;
      }
    },
    ticketSettingsChanged: (value) => ticketSettings.set(value),
    cancellingBothBracketsOnly: () =>
      policy.get().flags.supportCancellingBothBracketsOnly,
    state,
    scope,
    dialogs,
    notifications,
    orders,
    positions,
    individualPositions,
    executionUpdate: executionDemand.push,
    active: () => account.alive,
    read,
    update: account.applyUpdate,
    diagnostic,
    connectionChanged: account.connectionChanged,
    accountChanged: account.accountChanged,
    patchConfig: (changes) => {
      capabilities.patchConfig(changes);
      updatePolicy();
    },
    setDurations: (durations: OrderDurationMetaInfo[]) => {
      capabilities.setDurations(durations);
      updatePolicy();
    },
    symbolInfo,
    depthUpdate: demand.hostDepth,
    quoteUpdate: demand.hostQuotes,
  });
  // Restore the user's Buy/sell buttons choice; a broker may still change the live value later.
  if (displayPreferences.state.get().showBuySellButtons === false) host.sellBuyButtonsVisibility()?.setValue(false);
  let installedCommands: TradingCommands | undefined;
  const chartEdits = createChartOrderEdit(state, (id, kind) => {
    if (!installedCommands) throw TradingError.brokerUnavailable();
    return installedCommands.context(id, kind);
  });
  scope.own(() => chartEdits.destroy());
  scope.own(() => {
    state.destroy();
    policy.destroy();
    accounts.destroy();
    notifications.destroy();
  });
  scope.own(() => dialogs.destroy());
  scope.own(() => demand.destroy());
  scope.own(() => executionDemand.destroy());
  scope.own(() => coordinator.destroy());
  for (const dataset of datasets) scope.own(() => dataset.destroy());
  for (const store of [
    state.orders,
    state.positions,
    state.individualPositions,
  ])
    scope.own(
      store.subscribeChanges(() =>
        queueMicrotask(() => {
          if (account.alive) coordinator.changed();
        }),
      ),
    );
  scope.own(() => options.extensions?.disposeBroker?.());
  scope.own(() => installedCommands?.invalidatePreviews());
  const destroy = account.destroy;
  try {
    const debugSequence = { next: 0 };
    broker = debugBrokerSide(
      options.brokerFactory(
        debugBrokerSide(host, "host", options.debugBroker, debugLog, debugSequence),
      ),
      "broker",
      options.debugBroker,
      debugLog,
      debugSequence,
    );
    brokerReady.resolve(broker);
    installedCommands = new TradingCommands({
      broker,
      beginProtectionNotifications: protectionNotifications.begin,
      alwaysPassCalledOrderToModify: features.always_pass_called_order_to_modify,
      state,
      coordinator,
      policy: symbolPolicy,
      orderPreviewEnabled: () =>
        !!hostOptions.requireConfirmation ||
        ticketSettings.get().showOrderPreview,
      symbolInfo,
      now: () => clock.now(),
      clockSkewToleranceSeconds: options.clockSkewToleranceSeconds,
      read,
      refreshLeverageDependencies: async (symbol) => {
        await catalog.refresh(symbol);
        demand.refreshFinancial(symbol);
      },
      refresh: requestRefresh,
      refreshPositions: () => positions.refresh(),
      orderOptions: (symbol) =>
        read(() => getBroker().getOrderDialogOptions?.(symbol)),
      extensions: options.extensions,
      customClose: config.customUI?.showClosePositionDialog,
      closePreview: options.extensions?.previewClosePosition
        ? (request) =>
            read(() => options.extensions!.previewClosePosition!(request))
        : undefined,
      positionOptions: (symbol: string) =>
        read(() => getBroker().getPositionDialogOptions?.(symbol)),
      selectAccount,
    });
    account.start();
  } catch (cause) {
    account.constructionFailed(cause);
  }
  return {
    chartEdits,
    hasCustomPositionDialog: !!config.customUI?.showPositionDialog,
    hasCustomOrderDialog: !!config.customUI?.showOrderDialog,
    confirmationRequired: !!hostOptions.requireConfirmation,
    ticketSettings: valueReader(ticketSettings),
    displaySettings: displayPreferences.state,
    displaySettingsError: displayPreferences.error,
    /** The host's privacy mode: chart money the platform estimates is masked while it is on. */
    privacyMode: valueReader(privacyMode),
    /** Whether the position line names the currency of account-currency money P&L. */
    showPositionProfitCurrency: options.showPositionProfitCurrency === true,
    /** A mounted UI routes `showTradingProperties` to its host's settings page; the latest registration wins. */
    setSettingsOpener(open: () => boolean): () => void {
      settingsOpener = open;
      return () => {
        if (settingsOpener === open) settingsOpener = undefined;
      };
    },
    updateDisplaySettings: displayPreferences.update,
    preferences: Object.freeze({
      get(name: string): string | undefined {
        if (!account.alive)
          throw TradingError.disposed();
        return options.settings.get(
          preferencesKey(hostOptions.settingsKey, `ui.${encodeURIComponent(name)}`),
        );
      },
      set(name: string, value: string): void {
        if (!account.alive)
          throw TradingError.disposed();
        options.settings.set(
          preferencesKey(hostOptions.settingsKey, `ui.${encodeURIComponent(name)}`),
          value,
        );
      },
      remove(name: string): void {
        if (!account.alive)
          throw TradingError.disposed();
        options.settings.remove(
          preferencesKey(hostOptions.settingsKey, `ui.${encodeURIComponent(name)}`),
        );
      },
    }),
    features,
    host,
    ready: completion.promise,
    clock: Object.freeze({
      now: () => clock.now(),
      setTimeout: (callback: () => void, milliseconds: number) =>
        clock.setTimeout(callback, milliseconds),
      clearTimeout: (handle: unknown) => clock.clearTimeout(handle),
    }),
    state: Object.freeze({
      orders: entityReader(state.orders),
      history: entityReader(state.history),
      positions: entityReader(state.positions),
      individualPositions: entityReader(state.individualPositions),
      executions: entityReader(state.executions),
      tablePL: entityReader(state.tablePL),
      individualTablePL: entityReader(state.individualTablePL),
      balances: entityReader(state.balances),
      quotes: entityReader(state.quotes),
      pipValues: entityReader(state.pipValues),
      connection: valueReader(state.connection),
      equity: valueReader(state.equity),
      marginAvailable: valueReader(state.marginAvailable),
    }),
    policy: valueReader(policy),
    accounts: valueReader(accounts),
    notifications: valueReader(notifications),
    dialogs: {
      current: valueReader(dialogs.current),
      respond: dialogs.respond.bind(dialogs),
      respondAmount: dialogs.respondAmount.bind(dialogs),
    },
    get commands() {
      if (!installedCommands)
        throw TradingError.brokerUnavailable();
      return installedCommands;
    },
    get accountManagerInfo() {
      return managerInfo;
    },
    pending: entityReader(coordinator.pending),
    datasets: {
      orders: valueReader(orders.status),
      history: valueReader(history.status),
      positions: valueReader(positions.status),
      individualPositions: valueReader(individualPositions.status),
    },
    symbolInfo,
    async isTradable(symbol: string): Promise<boolean> {
      return (await tradability(symbol)).tradable;
    },
    tradability,
    /** Broker `chartContextMenuActions` for a chart price; the host default is `defaultContextMenuActions`. */
    async chartContextMenuActions(
      context: TradeContext,
    ): Promise<readonly ActionMetaInfo[]> {
      await brokerReady.promise;
      if (!account.alive)
        throw TradingError.disposed();
      const actions = await read(() =>
        getBroker().chartContextMenuActions(context, {}),
      );
      return Array.isArray(actions) ? actions : [];
    },
    symbolPolicy,
    symbolOptionsRevision: catalog.revision,
    /** tradedGroupConfig.supportAdaptiveLayout (default true): line TP/SL buttons and P&L hide on narrow screens. */
    adaptiveTradingLines: config.tradedGroupConfig?.supportAdaptiveLayout !== false,
    /** Editability for an existing order, using the same parent and permission rules as dispatch. */
    orderEditability(order: Readonly<Order>) {
      return orderEditability(
        order,
        symbolPolicy(order.symbol),
        modificationParentAvailable(state, order),
      );
    },
    refresh,
    destroy,
    async showOrderTicket(
      binding: TradingChartBinding,
      order: PreOrder,
    ) {
      if (!account.alive)
        throw TradingError.disposed();
      const epoch = account.generation;
      const result = config.customUI?.showOrderDialog
        ? await config.customUI.showOrderDialog(structuredClone(order))
        : await dialogs.request({ kind: "order", order, binding });
      if (!account.alive || epoch !== account.generation)
        throw TradingError.accountChanged();
      return result;
    },
    async requestLeverage(
      request: LeverageRequest,
      signal?: AbortSignal,
    ) {
      if (!installedCommands)
        throw TradingError.brokerUnavailable();
      const info = await installedCommands.leverageInfo(request);
      if (signal?.aborted) return false;
      return dialogs.request({ kind: "leverage", ...request, info }, signal);
    },
    requestClose: createCloseFlow({ state, dialogs, commands: () => installedCommands, symbolPolicy, symbolInfo }),
    formatters: catalog.formatters,
    orderDialogOptions: (symbol: string) =>
      read(() => getBroker().getOrderDialogOptions?.(symbol)),
    positionDialogOptions: (symbol: string) =>
      read(() => getBroker().getPositionDialogOptions?.(symbol)),
    acquireExecutions: executionDemand.acquire,
    acquireQuotes: demand.acquireQuotes,
    acquireDepth: demand.acquireDepth,
    acquireFinancial: demand.acquireFinancial,
  };
}
export type TradingSession = ReturnType<typeof createTradingSession>;
