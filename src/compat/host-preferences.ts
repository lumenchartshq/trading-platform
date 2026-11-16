import { preferencesKey } from "../core/preferences-key.js";
import { BottomWidgetBarMode } from "../contracts/broker.js";
import type {
  IBrokerConnectionAdapterHost,
  OrderTicketSettings,
  SuggestedQtyChangedListener,
} from "../contracts/broker.js";
import type { TradingSettingsPort } from "../contracts/ports.js";
import { DisposalScope } from "../core/disposal.js";
import { TradingError } from "../core/errors.js";
import { WatchedValue } from "./watched-value.js";
type PreferenceHost = Pick<
  IBrokerConnectionAdapterHost,
  | "sellBuyButtonsVisibility"
  | "domPanelVisibility"
  | "orderPanelVisibility"
  | "tradedSourcesVisibility"
  | "silentOrdersPlacement"
  | "getAccountManagerVisibilityMode"
  | "setAccountManagerVisibilityMode"
  | "activateBottomWidget"
  | "getOrderTicketSetting"
  | "setOrderTicketSetting"
  | "setQty"
  | "getQty"
  | "subscribeSuggestedQtyChange"
  | "unsubscribeSuggestedQtyChange"
>;
export function createHostPreferences(
  settings: TradingSettingsPort,
  namespace: string,
  requireConfirmation: boolean,
  defaultQty: (symbol: string) => Promise<number>,
  scope: DisposalScope,
  ticketSettingsChanged: (value: Readonly<OrderTicketSettings>) => void,
  /** Receives invalid synchronous host input and listener failures; the adapter never sees an exception. */
  report: (method: string, cause: unknown) => void = () => {},
): PreferenceHost {
  let alive = true;
  const assertAlive = () => {
    if (!alive)
      throw TradingError.disposed();
  };
  const key = (name: string) => preferencesKey(namespace, name);
  const watched = <T>(name: string, value: T, accepts?: (next: T) => boolean) => {
    const result = new WatchedValue(value, accepts, (cause) => report(name, cause));
    scope.own(() => result.destroy());
    return result;
  };
  const buySell = watched("sellBuyButtonsVisibility", true),
    dom = watched("domPanelVisibility", false),
    order = watched("orderPanelVisibility", false),
    sources = watched("tradedSourcesVisibility", true);
  const silent = watched(
    "silentOrdersPlacement",
    !requireConfirmation &&
      settings.get(key("silentOrdersPlacement")) === "true",
    (next) => !requireConfirmation || next === false,
  );
  const accountMode = watched("getAccountManagerVisibilityMode", BottomWidgetBarMode.Normal);
  silent.subscribe((value) =>
    settings.set(key("silentOrdersPlacement"), String(value)),
  );
  const ticketSettings: OrderTicketSettings = {
    showRelativePriceControl:
      settings.get(key("showRelativePriceControl")) === "true",
    showOrderPreview:
      requireConfirmation || settings.get(key("showOrderPreview")) !== "false",
  };
  ticketSettingsChanged({ ...ticketSettings });
  const assertTicketSetting = (name: keyof OrderTicketSettings) => {
    if (typeof name !== "string" || !Object.hasOwn(ticketSettings, name))
      throw new TradingError("invalid-input", "Unknown order ticket setting.");
  };
  const quantities = new Map<string, number>();
  const listeners = new Map<string, Set<SuggestedQtyChangedListener>>();
  scope.own(() => {
    alive = false;
    quantities.clear();
    listeners.clear();
  });
  const setQty = (symbol: string, quantity: number) => {
    if (!alive) return;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      report("setQty", new TradingError("invalid-input", "Enter a positive quantity."));
      return;
    }
    if (quantities.get(symbol) === quantity) return;
    quantities.set(symbol, quantity);
    try {
      settings.set(key(`qty.${encodeURIComponent(symbol)}`), String(quantity));
      for (const listener of [...(listeners.get(symbol) ?? [])])
        listener(quantity);
    } catch (cause) {
      report("setQty", cause);
    }
  };
  return {
    sellBuyButtonsVisibility: () => buySell,
    domPanelVisibility: () => dom,
    orderPanelVisibility: () => order,
    tradedSourcesVisibility: () => sources,
    silentOrdersPlacement: () => silent,
    getAccountManagerVisibilityMode: () => accountMode,
    setAccountManagerVisibilityMode: (mode) => {
      if (alive) accountMode.setValue(mode);
    },
    activateBottomWidget: async () => {
      assertAlive();
      accountMode.setValue(BottomWidgetBarMode.Normal);
    },
    getOrderTicketSetting: async (name) => {
      assertAlive();
      assertTicketSetting(name);
      return ticketSettings[name];
    },
    setOrderTicketSetting: async (name, value) => {
      assertAlive();
      assertTicketSetting(name);
      if (typeof value !== "boolean")
        throw new TradingError(
          "invalid-input",
          "Order ticket settings must be true or false.",
        );
      if (name === "showOrderPreview" && requireConfirmation && !value)
        throw new TradingError(
          "unsupported",
          "Order confirmation is required.",
        );
      ticketSettings[name] = value;
      ticketSettingsChanged({ ...ticketSettings });
      settings.set(key(name), String(value));
    },
    setQty,
    getQty: async (symbol) => {
      assertAlive();
      const current = quantities.get(symbol);
      if (current !== undefined) return current;
      const persisted = settings.get(key(`qty.${encodeURIComponent(symbol)}`));
      const parsed = persisted === undefined ? NaN : Number(persisted);
      if (Number.isFinite(parsed) && parsed > 0) {
        quantities.set(symbol, parsed);
        return parsed;
      }
      const value = await defaultQty(symbol);
      assertAlive();
      // A host override delivered during the instrument read takes precedence.
      return quantities.get(symbol) ?? value;
    },
    subscribeSuggestedQtyChange: (symbol, listener) => {
      if (alive) {
        let set = listeners.get(symbol);
        if (!set) {
          set = new Set();
          listeners.set(symbol, set);
        }
        set.add(listener);
      }
    },
    unsubscribeSuggestedQtyChange: (symbol, listener) => {
      const set = listeners.get(symbol);
      set?.delete(listener);
      if (set?.size === 0) listeners.delete(symbol);
    },
  };
}
