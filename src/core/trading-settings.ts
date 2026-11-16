import { NotificationType } from "../contracts/broker.js";
import type { IBrokerConnectionAdapterHost } from "../contracts/broker.js";
import type {
  Dispose,
  ReadonlyValue,
  TradingDisplaySettings,
  TradingLineAlignment,
  TradingProfitDisplayMode,
  TradingSettingsField,
  TradingSettingsPageSnapshot,
  TradingSettingsSection,
  TradingSettingsValue,
} from "../contracts/ports.js";
import type { CapabilityFlags } from "./capabilities.js";
import { isLineAlignment, isProfitDisplayMode } from "./display-preferences.js";
import { TradingError } from "./errors.js";

/** The settings page id hosts register and open. */
export const TRADING_SETTINGS_PAGE_ID = "trading";
export const TRADING_SETTINGS_PAGE_LABEL = "Trading";

/** Every display setting with its reference default filled in. */
export type EffectiveDisplaySettings = Required<TradingDisplaySettings>;

export function effectiveDisplay(display: Readonly<TradingDisplaySettings>): EffectiveDisplaySettings {
  return {
    positionProfitDisplay: display.positionProfitDisplay,
    showPositionProfit: display.showPositionProfit,
    multipleExitLevels: display.multipleExitLevels ?? false,
    showBuySellButtons: display.showBuySellButtons ?? true,
    showProfit: display.showProfit ?? true,
    showBracketProfit: display.showBracketProfit ?? true,
    bracketProfitDisplay: display.bracketProfitDisplay ?? "money",
    showPositions: display.showPositions ?? true,
    showOrders: display.showOrders ?? true,
    showReverse: display.showReverse ?? true,
    showExecutions: display.showExecutions ?? true,
    showExecutionLabels: display.showExecutionLabels ?? false,
    extendLines: display.extendLines ?? true,
    lineAlignment: display.lineAlignment ?? "right",
    executionSound: display.executionSound ?? false,
    rejectionNotificationsOnly: display.rejectionNotificationsOnly ?? false,
  };
}

/** Position P&L shows only while both the parent P&L switch and its own switch are on. */
export function positionProfitVisible(display: Readonly<TradingDisplaySettings>): boolean {
  return display.showProfit !== false && display.showPositionProfit;
}

export function bracketProfitVisible(display: Readonly<TradingDisplaySettings>): boolean {
  return display.showProfit !== false && display.showBracketProfit !== false;
}

export function bracketProfitMode(display: Readonly<TradingDisplaySettings>): TradingProfitDisplayMode {
  return display.bracketProfitDisplay ?? "money";
}

/** Bracket money text needs pip values unless amounts stay in instrument currency. */
export function bracketProfitInMoney(display: Readonly<TradingDisplaySettings>): boolean {
  return bracketProfitVisible(display) && bracketProfitMode(display) === "money";
}

/** Toasts honour "Show only rejection notifications"; the notification log keeps every entry. */
export function showsToast(type: NotificationType, display: Readonly<TradingDisplaySettings>): boolean {
  return display.rejectionNotificationsOnly !== true || type === NotificationType.Error;
}

/** What the settings page reads and writes; a trading session satisfies it. */
export interface TradingSettingsSource {
  readonly displaySettings: ReadonlyValue<TradingDisplaySettings>;
  updateDisplaySettings(patch: Partial<TradingDisplaySettings>): void;
  readonly policy: ReadonlyValue<{ readonly flags: Pick<CapabilityFlags, "supportMultipleExitLevels"> }>;
  readonly confirmationRequired: boolean;
  readonly features: { readonly buy_sell_buttons: boolean };
  readonly host: Pick<IBrokerConnectionAdapterHost, "sellBuyButtonsVisibility" | "silentOrdersPlacement">;
}

const profitOptions = [
  { value: "money", label: "Money" },
  { value: "ticks", label: "Ticks" },
  { value: "percentage", label: "%" },
] as const;
const alignmentOptions = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
] as const;

/** The page layout, following the reference terminal's Trading settings. */
function sections(source: TradingSettingsSource): readonly TradingSettingsSection[] {
  // A row is listed only when it can take effect for this host.
  const general: TradingSettingsField[] = [];
  if (source.features.buy_sell_buttons)
    general.push({ kind: "checkbox", id: "buySellButtons", label: "Buy/sell buttons", description: "Displays buy and sell buttons directly on the chart" });
  general.push(
    {
      kind: "checkbox",
      id: "oneClickTrading",
      label: "One-click trading",
      description: "Instantly place, edit, cancel orders, or close positions without confirmation",
      ...(source.confirmationRequired ? { disabled: true } : {}),
    },
  );
  if (source.policy.get().flags.supportMultipleExitLevels)
    general.push({
      kind: "checkbox",
      id: "multipleExitLevels",
      label: "Multiple exit levels",
      description: "Allows adding multiple take profit and stop loss levels directly on the chart",
    });
  general.push(
    { kind: "checkbox", id: "executionSound", label: "Play sound for executions" },
    { kind: "checkbox", id: "rejectionNotificationsOnly", label: "Show only rejection notifications" },
  );
  return [
    { id: "general", title: "General", fields: general },
    {
      id: "appearance",
      title: "Appearance",
      fields: [
        { kind: "checkbox", id: "positionsAndOrders", label: "Positions and orders" },
        {
          kind: "checkbox",
          id: "showReverse",
          label: "Reverse position button",
          description: "Adds the reverse button next to the open position on the chart",
          parent: "positionsAndOrders",
        },
        { kind: "checkbox", id: "showProfit", label: "Profit and loss value" },
        {
          kind: "checkbox",
          id: "showPositionProfit",
          label: "Positions",
          parent: "showProfit",
          select: { id: "positionProfitDisplay", label: "Position profit and loss unit", options: profitOptions },
        },
        {
          kind: "checkbox",
          id: "showBracketProfit",
          label: "Brackets",
          parent: "showProfit",
          select: { id: "bracketProfitDisplay", label: "Bracket profit and loss unit", options: profitOptions },
        },
        { kind: "checkbox", id: "showExecutions", label: "Execution marks" },
        { kind: "checkbox", id: "showExecutionLabels", label: "Execution labels", parent: "showExecutions" },
        { kind: "checkbox", id: "extendLines", label: "Extended price lines across the entire chart width" },
        { kind: "select", id: "lineAlignment", label: "Order and position alignment", options: alignmentOptions },
      ],
    },
  ];
}

function fieldIds(list: readonly TradingSettingsSection[]): Set<string> {
  const ids = new Set<string>();
  for (const section of list)
    for (const field of section.fields) {
      ids.add(field.id);
      if (field.kind === "checkbox" && field.select) ids.add(field.select.id);
    }
  return ids;
}

/** Last layout per source: an unchanged layout keeps its identity so rendered rows are not rebuilt. */
const layouts = new WeakMap<TradingSettingsSource, { readonly key: string; readonly sections: readonly TradingSettingsSection[] }>();
function stableSections(source: TradingSettingsSource): readonly TradingSettingsSection[] {
  const next = sections(source),
    key = JSON.stringify(next),
    previous = layouts.get(source);
  if (previous?.key === key) return previous.sections;
  layouts.set(source, { key, sections: next });
  return next;
}

export function tradingSettingsSnapshot(source: TradingSettingsSource): TradingSettingsPageSnapshot {
  const display = effectiveDisplay(source.displaySettings.get());
  const values: Record<string, TradingSettingsValue> = {
    buySellButtons: source.host.sellBuyButtonsVisibility()?.value() ?? true,
    oneClickTrading: source.host.silentOrdersPlacement().value(),
    multipleExitLevels: display.multipleExitLevels,
    executionSound: display.executionSound,
    rejectionNotificationsOnly: display.rejectionNotificationsOnly,
    positionsAndOrders: display.showPositions && display.showOrders,
    showReverse: display.showReverse,
    showProfit: display.showProfit,
    showPositionProfit: display.showPositionProfit,
    positionProfitDisplay: display.positionProfitDisplay,
    showBracketProfit: display.showBracketProfit,
    bracketProfitDisplay: display.bracketProfitDisplay,
    showExecutions: display.showExecutions,
    showExecutionLabels: display.showExecutionLabels,
    extendLines: display.extendLines,
    lineAlignment: display.lineAlignment,
  };
  const layout = stableSections(source);
  const visible = fieldIds(layout);
  return Object.freeze({
    sections: layout,
    values: Object.freeze(Object.fromEntries(Object.entries(values).filter(([id]) => visible.has(id)))),
  });
}

const displayKeys = {
  multipleExitLevels: "multipleExitLevels",
  executionSound: "executionSound",
  rejectionNotificationsOnly: "rejectionNotificationsOnly",
  showReverse: "showReverse",
  showProfit: "showProfit",
  showPositionProfit: "showPositionProfit",
  showBracketProfit: "showBracketProfit",
  showExecutions: "showExecutions",
  showExecutionLabels: "showExecutionLabels",
  extendLines: "extendLines",
} as const satisfies Record<string, keyof TradingDisplaySettings>;

/**
 * Writes changed page fields to their owners: display preferences, or the host's buy/sell button and
 * one-click values. Every field is validated before anything is written.
 */
export function applyTradingSettings(
  source: TradingSettingsSource,
  patch: Readonly<Record<string, TradingSettingsValue>>,
): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new TradingError("invalid-input", "Trading settings must be an object.");
  const known = fieldIds(sections(source));
  const display: { -readonly [Key in keyof TradingDisplaySettings]?: TradingDisplaySettings[Key] } = {};
  let buySell: boolean | undefined, oneClick: boolean | undefined;
  for (const [id, value] of Object.entries(patch)) {
    if (!known.has(id)) throw new TradingError("invalid-input", "Unknown trading setting.");
    if (id === "positionProfitDisplay" || id === "bracketProfitDisplay") {
      if (!isProfitDisplayMode(value)) throw new TradingError("invalid-input", "Choose a valid profit display.");
      display[id] = value;
      continue;
    }
    if (id === "lineAlignment") {
      if (!isLineAlignment(value)) throw new TradingError("invalid-input", "Choose a valid line alignment.");
      display.lineAlignment = value as TradingLineAlignment;
      continue;
    }
    if (typeof value !== "boolean") throw new TradingError("invalid-input", "Choose on or off.");
    if (id === "buySellButtons") {
      buySell = value;
      display.showBuySellButtons = value;
    }
    else if (id === "oneClickTrading") {
      if (value && source.confirmationRequired)
        throw new TradingError("invalid-input", "This broker requires order confirmation.");
      oneClick = value;
    } else if (id === "positionsAndOrders") {
      display.showPositions = value;
      display.showOrders = value;
    } else display[displayKeys[id as keyof typeof displayKeys]] = value;
  }
  if (Object.keys(display).length) source.updateDisplaySettings(display);
  if (buySell !== undefined) source.host.sellBuyButtonsVisibility()?.setValue(buySell);
  if (oneClick !== undefined) {
    const watched = source.host.silentOrdersPlacement();
    // A previous storage failure can leave the live value changed; notify again to retry persistence.
    const force = watched.value() === oneClick;
    // The platform's own watched value returns a save failure so this page can report it; adapters never see it.
    const failure = trySetValue(watched, oneClick, force);
    if (failure) throw failure.cause;
  }
}

/** Notifies when the page's fields or values may have changed outside the dialog. */
export function subscribeTradingSettings(source: TradingSettingsSource, listener: () => void): Dispose {
  const buySell = source.host.sellBuyButtonsVisibility(),
    oneClick = source.host.silentOrdersPlacement();
  const changed = () => listener();
  const releases = [source.displaySettings.subscribe(changed), source.policy.subscribe(changed)];
  buySell?.subscribe(changed);
  oneClick.subscribe(changed);
  return () => {
    for (const release of releases) release();
    buySell?.unsubscribe(changed);
    oneClick.unsubscribe(changed);
  };
}

type TrySet<T> = { trySetValue(value: T, force?: boolean): { readonly cause: unknown } | undefined };
function trySetValue<T>(watched: { setValue(value: T, force?: boolean): void }, value: T, force: boolean) {
  if ("trySetValue" in watched && typeof (watched as unknown as TrySet<T>).trySetValue === "function")
    return (watched as unknown as TrySet<T>).trySetValue(value, force);
  watched.setValue(value, force);
  return undefined;
}
