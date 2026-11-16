import { sideName } from "../core/order-labels.js";
import { sameAccountGeneration } from "../core/identity.js";
import { decimalPlaces } from "../core/number-precision.js";
import { effectiveTick, snapToStep } from "../core/trading-rules.js";
import { contextOrderType, contextTradeLabel, defaultTradeActionSide, isTradingSettingsAction } from "../core/context-orders.js";
import { symbolLabel } from "../core/features.js";
import { Side } from "../contracts/broker.js";
import type {
  ActionDescriptionWithCallback,
  ActionMetaInfo,
  InstrumentInfo,
} from "../contracts/broker.js";
import type { TradingChartBinding, TradingContextAction } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
const contextActionsTimeoutMs = 1000;

export function createContextActions(
  session: TradingSession,
  instrumentFor: (symbol: string) => InstrumentInfo | undefined,
  onError: (cause: unknown) => void,
) {
  return async (
    target: TradingChartBinding,
    price?: number,
    source: "pane" | "priceScale" = "pane",
  ): Promise<readonly TradingContextAction[]> => {
    if (!session.features.chart_crosshair_menu) return [];
    // Trade items appear only where the broker can trade; both menus share this one (cached) answer.
    const tradable = await session.tradability(target.symbol).then(result => result.tradable, () => false);
    if (!tradable && source === "priceScale") return [];
    const instrument = instrumentFor(target.symbol);
    const quote = session.state.quotes.get(target.symbol);
    const market = quote?.trade ?? quote?.bid ?? quote?.ask;
    const priced = price !== undefined && market !== undefined && Number.isFinite(price);
    const tick = priced && instrument ? effectiveTick(price, instrument) : undefined;
    const snapped = priced && tick ? snapToStep(price, tick) : price;
    const decimals = tick ? decimalPlaces(tick) : 2;
    const formattedValue = priced && snapped !== undefined ? snapped.toFixed(decimals) : "";
    /** The platform's own Buy/Sell entry: an intent bound to this chart at the snapped price. */
    const tradeItem = (side: Side): TradingContextAction => {
      const name = sideName(side);
      const icon = side === Side.Buy ? "buy" : "sell";
      if (!priced || snapped === undefined)
        return { text: name, icon, intent: { type: "openTicket" as const, binding: target, side, price } };
      // Reference wording: "Buy @ 99.40 Limit" below the market, "Buy @ 101.20 Stop" above it.
      const orderType = contextOrderType(side, price, market);
      return {
        text: contextTradeLabel({ side, formattedPrice: formattedValue, type: orderType }),
        icon,
        intent: { type: "openTicket" as const, binding: target, side, price: snapped, orderType },
      };
    };
    const captured = session.state.connection.get();
    /** Items act only for the account and connection they were built for. */
    const alive = () => {
      const current = session.state.connection.get();
      return current.phase === "ready" && sameAccountGeneration(current, captured);
    };
    const symbolText = symbolLabel(target.symbol, session.features, instrument?.brokerSymbol);
    const qty = source === "priceScale" ? await session.host.getQty(target.symbol) : undefined;
    const decorate = (item: TradingContextAction): TradingContextAction => {
      if (source !== "priceScale" || !("intent" in item)) return item;
      const side = item.intent.type === "openTicket" ? item.intent.side : undefined;
      if (side === undefined) return item;
      const orderType = contextOrderType(side, snapped!, market!);
      return {
        ...item,
        price: snapped,
        formattedPrice: formattedValue,
        text: contextTradeLabel({ side, qty, symbol: symbolText, formattedPrice: formattedValue, type: orderType }),
        intent: { ...item.intent, type: "priceOrder" } as typeof item.intent,
      };
    };
    const finish = (all: readonly TradingContextAction[]) => {
      if (!alive()) return [];
      // Order intents need a tradable symbol; broker actions such as Trading settings stay.
      const items = tradable ? all : all.filter((item) => !("intent" in item));
      const mapped = items.map(decorate).map((item) => {
        if (
          source === "priceScale" &&
          "intent" in item &&
          (item.intent.type === "openTicket" || item.intent.type === "priceOrder")
        )
          return { ...item, intent: { ...item.intent, account: captured } };
        if ("run" in item)
          return {
            ...item,
            run: () => {
              if (alive()) item.run();
            },
          };
        return item;
      });
      if (source === "priceScale" && mapped.some((item) => "intent" in item))
        mapped.push({
          text: `Add order on ${symbolText} at ${formattedValue}…`,
          icon: "add_order",
          intent: {
            type: "openTicket",
            account: captured,
            binding: target,
            side: Side.Buy,
            price: snapped,
            orderType: contextOrderType(Side.Buy, snapped!, market!),
          },
        });
      return mapped;
    };
    if (source === "priceScale" && (!priced || !instrument)) return [];
    const local = [tradeItem(Side.Buy), tradeItem(Side.Sell)];
    let actions: readonly ActionMetaInfo[] | undefined;
    let timer: unknown;
    try {
      // The broker decides the items (usually `host.defaultContextMenuActions`); an empty list removes them.
      // A broker that does not answer within a second gets the platform's own Buy/Sell items.
      actions = await Promise.race([
        session.chartContextMenuActions({
          symbol: target.symbol,
          displaySymbol: symbolLabel(target.symbol, session.features, instrument?.brokerSymbol),
          value: priced && snapped !== undefined ? snapped : null,
          formattedValue,
          last: market ?? Number.NaN,
        }),
        new Promise<undefined>((resolve) => {
          timer = session.clock.setTimeout(() => resolve(undefined), contextActionsTimeoutMs);
        }),
      ]);
    } catch (cause) {
      onError(cause);
      return finish(local);
    } finally {
      if (timer !== undefined) session.clock.clearTimeout(timer);
    }
    if (!actions) return finish(local);
    return finish(mapContextActions(actions, tradeItem));
  };
}

/** Map broker-owned actions without running their callbacks during projection. */
export function mapContextActions(
  actions: readonly ActionMetaInfo[],
  tradeItem: (side: Side) => TradingContextAction,
): TradingContextAction[] {
  return actions.flatMap((action): TradingContextAction[] => {
    if (!action || typeof action !== "object") return [];
    if ("separator" in action && action.separator) return [{ separator: true }];
    const side = defaultTradeActionSide(action);
    if (side !== undefined) return [tradeItem(side)];
    const callback = action as ActionDescriptionWithCallback;
    if (typeof callback.action !== "function") return [];
    return [
      {
        text: callback.text ?? "",
        enabled: callback.enabled !== false,
        run: () => callback.action(callback),
        ...(isTradingSettingsAction(action) && { icon: "trading_settings" as const }),
      },
    ];
  });
}
