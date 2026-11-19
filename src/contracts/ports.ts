import type { DOMData, IBrokerConnectionAdapterHost, IBrokerTerminal, OrderType, Side, SingleBrokerMetaInfo, TradingQuotes } from "./broker.js";
import type { IDatafeedChartApi, IDatafeedQuotesApi } from "./market-data.js";
import type { AccountId, ClosePositionPreviewResult, INumberFormatter, IPriceFormatter } from './broker.js';

export type Dispose = () => void;
export interface TradingClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ReadonlyValue<T> {
  get(): T;
  subscribe(listener: (value: T) => void): Dispose;
}
export interface TradingSettingsPort {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}
export interface TradingFormatterPort {
  defaultPrice(symbol: string, alignToMinMove: boolean): Promise<INumberFormatter>;
  numeric(decimalPlaces: number): Promise<INumberFormatter>;
  quantity(decimalPlaces?: number): Promise<INumberFormatter>;
  createPriceFormatter(priceScale?: number, minMove?: number, fractional?: boolean, minMove2?: number, variableMinTick?: string): IPriceFormatter;
}
/**
 * Lumen extension: how a broker adapter behaves, declared by the adapter itself so the conformance kit can hold it
 * to the declaration. Contract details such as the point value and P&L currency are declared on the instrument and
 * `positionPLInInstrumentCurrency` instead.
 */
export interface TradingBrokerProfile {
  /**
   * `immediate`: when a write's reply arrives, the broker's reads already show its result. `eventual`: the broker may
   * acknowledge a write first and show its result later (common for exchanges with an account stream).
   */
  readonly confirmation: 'immediate' | 'eventual';
  /** Every placement carries a client order ID, so a write whose reply was lost is found instead of sent again. */
  readonly clientOrderIds: boolean;
}
/** Lumen extensions deliberately do not change the pinned IBrokerTerminal. */
export interface LumenBrokerExtensions {
  disposeBroker?(): void;
  previewClosePosition?(request: {
    accountId: AccountId;
    positionId: string;
    individual: boolean;
    amount?: number;
  }): Promise<ClosePositionPreviewResult>;
}

export interface TradingQuoteSnapshot {
  readonly status: 'loading' | 'ready' | 'error';
  /** Initial reads and cached replays must be labelled snapshot; omitted means an authoritative live update. */
  readonly source?: 'snapshot' | 'stream';
  readonly value?: Readonly<TradingQuotes>;
  readonly error?: string;
}
export interface TradingMarketDataPort {
  acquireQuotes(symbol: string, speed: 'fast' | 'normal', listener: (snapshot: TradingQuoteSnapshot) => void): Dispose;
  acquireDepth(symbol: string, listener: (snapshot: Readonly<DOMData>) => void): Dispose;
}

export interface TradingChartBinding { readonly id: string; readonly generation: number; readonly symbol: string; }
export interface TradingEnvironment { readonly locale: string; readonly theme: 'light' | 'dark'; readonly timezone: string; readonly width: number; readonly height: number; }
export interface TradingSymbolContext {
  readonly symbol: string; readonly minTick: number; readonly priceScale: number; readonly minMove: number;
  readonly minMove2?: number; readonly fractional?: boolean; readonly variableMinTick?: string;
  readonly currency?: string; readonly type?: string; readonly resolved: boolean; readonly tradable: boolean; readonly hasBars: boolean;
}
export interface TradingProtectionView {
  readonly phase?: "draft" | "dragging" | "pending" | "inactive" | "confirmed";
  readonly showRegion?: boolean;
  readonly muted?: boolean;
  readonly profitDirection?: 1 | -1;
  readonly target?: string;
  readonly movingLeg?: TradingProtectionLeg;
  readonly entryPrice?: number;
  readonly handles: readonly TradingProtectionLeg[];
  /** Legs shown faded and not draggable while another leg is under review. */
  readonly lockedHandles?: readonly TradingProtectionLeg[];
  readonly preview?: { readonly leg: TradingProtectionLeg; readonly price: number; readonly text?: string; readonly quantity?: string; readonly invalid?: boolean };
}
export type TradingProtectionLeg = "takeProfit" | "stopLoss";
export type TradingOverlayAction = 'modify' | 'cancel' | 'close' | 'reverse' | 'protect' | 'submit';
export interface TradingPositionPill { readonly text: string; readonly tone?: "positive" | "negative" | "neutral"; }
export interface TradingOverlayStyle { readonly lineColor?: string; readonly textColor?: string; readonly lineWidth?: number; readonly lineStyle?: number; }
interface TradingOverlayBase {
  readonly pill?: TradingPositionPill;
  readonly protection?: TradingProtectionView;
  readonly key: string; readonly entityId: string; readonly symbol: string; readonly price: number; readonly label: string;
  /** Hover text; the label when absent. */
  readonly tooltip?: string;
  readonly side: Side; readonly quantity?: number; readonly group?: string;
  readonly actions: readonly TradingOverlayAction[]; readonly style?: TradingOverlayStyle;
}
export type TradingOverlaySpec = (TradingOverlayBase & { readonly kind: 'order' | 'position' | 'bracket' }) | (TradingOverlayBase & { readonly kind: 'execution'; readonly time: number });
export interface TradingOverlayPatch { readonly pill?: TradingPositionPill; readonly protection?: TradingProtectionView; readonly price?: number; readonly label?: string; /** Present when changed; undefined returns to the label. */ readonly tooltip?: string; readonly quantity?: number; readonly actions?: readonly TradingOverlayAction[]; readonly style?: TradingOverlayStyle; }
export type TradingOverlayEvent =
  | { readonly type: TradingOverlayAction }
  | { readonly type: 'dragStart' | 'dragPreview' | 'dragCommit' | 'dragCancel'; readonly gestureId: string; readonly price: number; readonly leg?: TradingProtectionLeg };
export interface TradingOverlayHandle { update(patch: TradingOverlayPatch): void; subscribe(listener: (event: TradingOverlayEvent) => void): Dispose; cancelInteraction(): void; remove(): void; }
export type ChartTradeIntent =
  | { readonly type: 'openTicket' | 'priceOrder'; readonly account?: { readonly accountId?: string; readonly generation: number }; readonly binding: TradingChartBinding; readonly side: Side; readonly price?: number; readonly orderType?: OrderType }
  | { readonly type: 'modifyOrder' | 'cancelOrder' | 'closePosition' | 'reversePosition'; readonly binding: TradingChartBinding; readonly entityId: string }
  | { readonly type: 'editProtection'; readonly binding: TradingChartBinding; readonly entityId: string; readonly entityKind: 'order' | 'position' | 'individualPosition' };
/** A chart context item: a trade intent the platform owns, a broker callback, or a separator. */
/** Glyph hint for a chart menu action; a host without a matching glyph shows the text alone. */
export type TradingContextActionIcon = 'buy' | 'sell' | 'add_order' | 'trading_settings';
export type TradingContextAction =
  | { readonly text: string; readonly intent: ChartTradeIntent; readonly price?: number; readonly formattedPrice?: string; readonly icon?: TradingContextActionIcon }
  | { readonly text: string; readonly run: () => void; readonly enabled?: boolean; readonly icon?: TradingContextActionIcon }
  | { readonly separator: true };
/** May resolve asynchronously (the broker's `chartContextMenuActions`); the chart menu waits for it. */
export type TradingContextActionsProvider = (binding: TradingChartBinding, price?: number, source?: "pane" | "priceScale") => readonly TradingContextAction[] | Promise<readonly TradingContextAction[]>;
export interface TradingChartPort {
  readonly binding: ReadonlyValue<TradingChartBinding>;
  symbolContext(): Promise<TradingSymbolContext>;
  /** Optional reactive host metadata; publish only when the context changes, not for every bar. */
  subscribeSymbolContext?(listener: (context: TradingSymbolContext) => void): Dispose;
  /** Host chart visibility, independent of the trading button preference. */
  readonly visible?: ReadonlyValue<boolean>;
  createOverlay(spec: TradingOverlaySpec): TradingOverlayHandle;
  onTradeIntent(listener: (intent: ChartTradeIntent) => void): Dispose;
  registerContextActions(provider: TradingContextActionsProvider): Dispose;
  /** Optional: show another symbol on this chart, e.g. a broker's "change symbol" solution for a non-tradable one. */
  requestSymbol?(symbol: string): void;
  /** Optional: chart-wide broker line layout; absent hosts keep their default layout. */
  setLineLayout?(layout: TradingLineLayout): void;
}
export type TradingCollectionEvent =
  | { readonly type: 'added'; readonly chart: TradingChartPort }
  | { readonly type: 'removed'; readonly binding: TradingChartBinding }
  | { readonly type: 'activeChanged'; readonly binding?: TradingChartBinding }
  | { readonly type: 'bindingChanged'; readonly previous: TradingChartBinding; readonly binding: TradingChartBinding };
export interface TradingCollectionPort { charts(): readonly TradingChartPort[]; activeChart(): TradingChartPort | undefined; subscribe(listener: (event: TradingCollectionEvent) => void): Dispose; }
export type TradingSurfaceKind = 'ticket' | 'accounts' | 'dom' | 'dialogs' | 'chart-controls';
/** Lumen host geometry, expressed in the presentation environment's CSS pixels. */
export interface TradingFloatingBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export type TradingTicketPlacement = { readonly mode: 'docked' } | { readonly mode: 'floating'; readonly bounds: TradingFloatingBounds };
/** The docks a presentation sizes for the platform. */
export type TradingDockKind = 'ticket' | 'accounts' | 'dom';
/**
 * Who sizes a dock: `platform` (the default) draws resize handles and may show the side pane as a compact overlay;
 * `host` lays the dock out itself, so the platform draws no handle and never makes the side pane compact; `fixed` is a
 * host box the panel cannot change, so the Account Manager also stays in its normal mode and offers no mode controls.
 */
export type TradingDockSizing = 'platform' | 'host' | 'fixed';
export interface TradingPresentationPort {
  readonly environment: ReadonlyValue<TradingEnvironment>;
  readonly settings: TradingSettingsPort;
  acquireSurface(kind: TradingSurfaceKind, chart?: TradingChartBinding): { readonly element: HTMLElement; readonly visible?: ReadonlyValue<boolean>; release: Dispose };
  /** The space a dock wants. `collapsed` and `maximized` describe the Account Manager's mode; a host that owns a dock's size forwards them. */
  setDockSize(kind: TradingDockKind, pixels: number, options?: { readonly maximized?: boolean; readonly collapsed?: boolean }): void;
  dockBounds?(kind: TradingDockKind, options?: { readonly maximized?: boolean }): Readonly<{ min: number; max: number }>;
  /** Optional: who sizes this dock. Absent means `platform`. */
  dockSizing?(kind: TradingDockKind): TradingDockSizing;
  /** Optional host extension; moving the owned ticket surface must preserve its mounted state. */
  setTicketPlacement?(placement: TradingTicketPlacement): void;
  notifyLayoutChanged(): void;
  /** Optional: symbol logo URLs when the host enables `show_symbol_logos`; resolves to an empty list when unavailable. */
  symbolLogos?(symbol: string): Promise<readonly string[]>;
  /** Optional: datafeed symbol search for the ticket when the broker sets `supportSymbolSearch`. */
  searchSymbols?(query: string): Promise<readonly TradingSymbolSearchResult[]>;
  searchSymbolsPage?(query: string, start: number, limit: number): Promise<TradingSymbolSearchPage>;
  /** Optional: add a page to the host's settings dialog; without it the platform keeps its own settings dialog. */
  registerSettingsPage?(page: TradingSettingsPage): Dispose;
  /** Optional: open the host's settings dialog on a registered page; false when it cannot. */
  openSettingsPage?(id: string): boolean;
}
export interface TradingSymbolSearchPage { readonly revision?: string; readonly items: readonly TradingSymbolSearchResult[]; readonly remaining: number; }
export interface TradingSymbolSearchResult { readonly symbol: string; readonly description?: string; readonly exchange?: string; }
export type TradingProfitDisplayMode = 'money' | 'ticks' | 'percentage';
export type TradingLineAlignment = 'left' | 'center' | 'right';
/**
 * User trading display choices. Optional fields fall back to the reference defaults: every visibility on except
 * execution labels, bracket P&L in money, extended lines, right alignment, no sound and every notification shown.
 */
export interface TradingDisplaySettings {
  readonly positionProfitDisplay: TradingProfitDisplayMode;
  readonly showPositionProfit: boolean;
  readonly multipleExitLevels?: boolean;
  /** The user's Buy/sell buttons choice, restored into `sellBuyButtonsVisibility` at startup. */
  readonly showBuySellButtons?: boolean;
  /** Parent switch over position and bracket P&L (`tradingProperties.positionAndBracketsPL`). */
  readonly showProfit?: boolean;
  readonly showBracketProfit?: boolean;
  readonly bracketProfitDisplay?: TradingProfitDisplayMode;
  readonly showPositions?: boolean;
  readonly showOrders?: boolean;
  readonly showReverse?: boolean;
  readonly showExecutions?: boolean;
  readonly showExecutionLabels?: boolean;
  /** Draw position and order lines across the whole pane (`tradingProperties.extendLeft`). */
  readonly extendLines?: boolean;
  readonly lineAlignment?: TradingLineAlignment;
  readonly executionSound?: boolean;
  /** Toasts show only rejections; the notification log keeps everything. */
  readonly rejectionNotificationsOnly?: boolean;
}
/** Lumen extension: one sound cue; the default plays a short tone through Web Audio when available. */
export interface TradingSoundPort { playExecution(): void; }
/** Chart-wide layout for broker lines. */
export interface TradingLineLayout { readonly extendLeft: boolean; readonly alignment: TradingLineAlignment; }
export type TradingSettingsValue = boolean | string;
export interface TradingSettingsOption { readonly value: string; readonly label: string; }
/** One row of a host settings page; data only, rendered by the host with its own controls. */
export type TradingSettingsField =
  | {
      readonly kind: 'checkbox'; readonly id: string; readonly label: string; readonly description?: string;
      /** Indents the row under this checkbox and disables it while that checkbox is off. */
      readonly parent?: string;
      readonly disabled?: boolean;
      /** A select on the same row, disabled while the checkbox is off. */
      readonly select?: { readonly id: string; readonly label: string; readonly options: readonly TradingSettingsOption[] };
    }
  | { readonly kind: 'select'; readonly id: string; readonly label: string; readonly options: readonly TradingSettingsOption[]; readonly parent?: string; readonly disabled?: boolean };
export interface TradingSettingsSection { readonly id: string; readonly title: string; readonly fields: readonly TradingSettingsField[]; }
export interface TradingSettingsPageSnapshot {
  readonly sections: readonly TradingSettingsSection[];
  readonly values: Readonly<Record<string, TradingSettingsValue>>;
}
/** A settings page contributed to the host's settings dialog. The host keeps the draft; `apply` receives changed fields only. */
export interface TradingSettingsPage {
  readonly id: string;
  readonly label: string;
  snapshot(): TradingSettingsPageSnapshot;
  apply(patch: Readonly<Record<string, TradingSettingsValue>>): void | Promise<void>;
  /** Called when fields or values change outside the dialog, e.g. a broker flag or an override. */
  subscribe(listener: () => void): Dispose;
}
export interface TradingSessionOptions {
  brokerFactory(host: IBrokerConnectionAdapterHost): IBrokerTerminal;
  brokerConfig?: SingleBrokerMetaInfo;
  marketData: TradingMarketDataPort; marketDataCapabilities?: { readonly quotes: boolean; readonly depth: boolean }; formatters: TradingFormatterPort; settings: TradingSettingsPort;
  enabledFeatures?: readonly string[]; disabledFeatures?: readonly string[];
  displaySettings?: Partial<TradingDisplaySettings>;
  clock?: TradingClock; extensions?: LumenBrokerExtensions; settingsKey?: string; requireConfirmation?: boolean;
  /** Lumen extension: the execution sound; defaults to a Web Audio tone where available. */
  sound?: TradingSoundPort;
  /**
   * Lumen extension: the host's privacy mode. While true, money the platform estimates for chart lines (exit lines,
   * estimated position profit) shows a mask. It never changes or saves the user's display settings.
   */
  privacyMode?: ReadonlyValue<boolean>;
  /**
   * Lumen extension: whether the position line also names the currency of money P&L in the account currency. Off
   * (the default, as in the reference terminal) shows the bare amount. Instrument-currency P&L
   * (`positionPLInInstrumentCurrency`) names its currency either way, and no unit shows while the currency is unknown.
   */
  showPositionProfitCurrency?: boolean;
  /** Pinned `debug_broker` widget option: log Broker API and Trading Host calls with matching IDs. */
  debugBroker?: 'all' | 'normal' | 'host-only' | 'broker-only';
  /** Destination for debug logs; defaults to `console.debug`. */
  debugLogger?: (message: string, ...details: unknown[]) => void;
  /**
   * Lumen extension: broker input the session dropped (an invalid push, a quarantined snapshot row, a trimmed
   * history). With `debugBroker` set, drops are also written to `debugLogger`. Never throws into the adapter.
   */
  diagnostics?: (diagnostic: TradingDiagnostic) => void;
  /**
   * Lumen extension: deadlines in milliseconds (defaults: command 10 s, reconcile 60 s, account switch 10 s, read 15 s,
   * snapshot 15 s).
   */
  deadlines?: TradingDeadlines;
  /** Lumen extension: most order-history rows kept from one read, newest first (default 5,000). */
  historyLimit?: number;
  /** Lumen extension: how far ahead of the broker the session clock may be when validating expiry (default 60 s). */
  clockSkewToleranceSeconds?: number;
}
export interface TradingDeadlines {
  /** Until an unmatched command is reported unconfirmed; it changes presentation, not the outcome. */
  readonly command?: number;
  /**
   * After the command deadline: how long an unconfirmed command keeps reconciling and holding its keys. 0 ends the
   * command at its deadline: it stays unconfirmed, its keys are released, and later broker updates change the account
   * data but not the command's record.
   */
  readonly reconcile?: number;
  readonly accountSwitch?: number;
  readonly read?: number;
  readonly snapshot?: number;
}
export interface TradingDiagnostic {
  /** Where the input entered: a host push, a snapshot read, a history trim, or instrument metadata. */
  readonly source: 'host' | 'snapshot' | 'history' | 'instrument';
  /** Host method or dataset name. */
  readonly method: string;
  readonly entityId?: string;
  readonly message: string;
}
/**
 * Lumen extension: the plain shape an adapter may throw or reject with so users see the broker's reason.
 * `message` must be user-safe; anything else rejected keeps the platform's generic wording.
 */
export interface BrokerRejection {
  readonly code: 'rejected' | 'unavailable' | 'invalid' | 'unsupported';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}
/** Lumen-only widget/mount overrides; no changes to the pinned broker interface. */
export type TradingSessionOverrides = Partial<Pick<TradingSessionOptions, 'clock' | 'extensions' | 'marketData' | 'marketDataCapabilities' | 'formatters' | 'settingsKey' | 'displaySettings' | 'sound' | 'privacyMode' | 'showPositionProfitCurrency'>>;
export interface TradingRuntime { readonly ready: Promise<void>; destroy(): void; }
export interface NativeTradingOptions { readonly abi: 1; readonly buildId: string; readonly session: Omit<TradingSessionOptions, 'marketData' | 'formatters'> & { readonly marketData?: TradingMarketDataPort; readonly formatters?: TradingFormatterPort }; readonly datafeed?: Partial<IDatafeedQuotesApi> & Pick<IDatafeedChartApi, 'subscribeDepth' | 'unsubscribeDepth'>; /** Host overrides remain readable while the optional asset is loading: `get` returns every override so far, listeners receive each applied patch. */
readonly displayOverrides?: ReadonlyValue<Partial<TradingDisplaySettings>>;
readonly collection: TradingCollectionPort; readonly presentation: TradingPresentationPort; }
export interface TradingModule { readonly abi: 1; readonly buildId: string; mount(options: NativeTradingOptions): TradingRuntime; }

/** Optional per-order restriction stored in Order.extra, without changing the pinned Broker API. */
export interface TradingOrderRestrictions { readonly editable?: boolean }
export const orderRestrictionsField = "lumenOrderRestrictions";
