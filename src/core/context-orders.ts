import { OrderType, Side } from "../contracts/broker.js";
import { sideName } from "./order-labels.js";

/** A pending order at a chart price: buying below the market is a limit, above it a stop; selling mirrors that. */
export function contextOrderType(
  side: Side,
  price: number,
  market: number,
): OrderType.Limit | OrderType.Stop {
  if (side === Side.Buy) return price < market ? OrderType.Limit : OrderType.Stop;
  return price > market ? OrderType.Limit : OrderType.Stop;
}
export const contextOrderTypeName = (type: OrderType.Limit | OrderType.Stop) =>
  type === OrderType.Limit ? "Limit" : "Stop";

/**
 * The one wording of a chart-price trade item: "Buy" for a market order, otherwise
 * "Buy [qty] [SYMBOL] @ 99.40 Limit" (reference wording; quantity and symbol only where the menu shows them).
 */
export function contextTradeLabel(input: {
  readonly side: Side;
  readonly qty?: number;
  readonly symbol?: string;
  readonly formattedPrice?: string;
  readonly type: OrderType;
}): string {
  const name = sideName(input.side);
  if (input.type !== OrderType.Limit && input.type !== OrderType.Stop) return name;
  const parts = [name, ...(input.qty !== undefined ? [String(input.qty)] : []), ...(input.symbol ? [input.symbol] : [])];
  return `${parts.join(" ")} @ ${input.formattedPrice ?? ""} ${contextOrderTypeName(input.type)}`;
}

/**
 * Buy/sell items produced by the host's `defaultContextMenuActions`. When a broker returns them from
 * `chartContextMenuActions`, the chart shows its own tick-snapped trade intent for that side instead.
 */
// A registered symbol, not a module-local WeakMap, so separately bundled host and chart code agree.
const defaultTradeSide = Symbol.for("lumen.trading.defaultTradeSide");
export function markDefaultTradeAction(action: object, side: Side): void {
  Object.defineProperty(action, defaultTradeSide, { value: side });
}
export function defaultTradeActionSide(action: object): Side | undefined {
  const side = (action as { [defaultTradeSide]?: unknown })[defaultTradeSide];
  return side === Side.Buy || side === Side.Sell ? side : undefined;
}

/** The host's own "Trading settings" item, so the chart menu can give it the settings glyph. */
const tradingSettingsAction = Symbol.for("lumen.trading.tradingSettingsAction");
export function markTradingSettingsAction(action: object): void {
  Object.defineProperty(action, tradingSettingsAction, { value: true });
}
export function isTradingSettingsAction(action: object): boolean {
  return (action as { [tradingSettingsAction]?: unknown })[tradingSettingsAction] === true;
}
