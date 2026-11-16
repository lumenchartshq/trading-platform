/** Trading-owned defaults from the pinned TradingTerminalFeatureset declarations.
 * Inherited chart features remain owned by the chart resolver.
 */
export const tradingFeatureDefaults = Object.freeze({
  chart_crosshair_menu: true,
  open_account_manager: true,
  trading_notifications: true,
  show_trading_notifications_history: true,
  always_pass_called_order_to_modify: false,
  always_require_order_confirmation: false,
  trading_account_manager: true,
  right_toolbar: true,
  order_panel: true,
  order_info: true,
  buy_sell_buttons: true,
  broker_button: true,
  show_order_panel_on_start: false,
  order_panel_close_button: true,
  order_panel_undock: true,
  chart_hide_close_position_button: false,
  chart_hide_close_order_button: false,
  dom_widget: false,
  dom_raw_volume_values: false,
  hide_right_toolbar: false,
  hide_right_toolbar_tabs: false,
  show_symbol_logo_in_account_manager: true,
  show_symbol_logo_in_close_position_dialog: true,
  show_symbol_logo_in_cancel_order_dialog: true,
  prefer_symbol_name_over_fullname: true,
  static_dom: false,
  show_buy_sell_buttons_on_unsupported_resolution: false,
} as const);
export type TradingFeature = keyof typeof tradingFeatureDefaults;
export type TradingFeatures = Readonly<Record<TradingFeature, boolean>>;
/** Unknown and inherited names are ignored. Explicit disable always wins. */
export function resolveTradingFeatures(
  enabled: readonly string[] = [],
  disabled: readonly string[] = [],
): TradingFeatures {
  const enabledSet = new Set(enabled),
    disabledSet = new Set(disabled);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(tradingFeatureDefaults).map(([name, fallback]) => [
        name,
        !disabledSet.has(name) && (enabledSet.has(name) || fallback),
      ]),
    ),
  ) as TradingFeatures;
}
/** prefer_symbol_name_over_fullname shows the symbol name instead of the `exchange:name` combination. */
/** Trading display name: the instrument's `brokerSymbol` when the broker supplies one, else the chart symbol. */
export function symbolLabel(chartSymbol: string, features: Pick<TradingFeatures, "prefer_symbol_name_over_fullname">, brokerSymbol?: string): string {
  const symbol = brokerSymbol || chartSymbol;
  if (!features.prefer_symbol_name_over_fullname) return symbol;
  const separator = symbol.lastIndexOf(":");
  return separator > 0 && separator < symbol.length - 1 ? symbol.slice(separator + 1) : symbol;
}
