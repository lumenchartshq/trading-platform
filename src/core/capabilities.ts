import { OrderType } from '../contracts/broker.js';
import type { BrokerConfigFlags, IBrokerTerminal, LumenBrokerExtensions, OrderDurationMetaInfo, SingleBrokerMetaInfo, SymbolSpecificTradingOptions } from '../contracts/index.js';
import { defaultFlags } from './capability-metadata.js';

export { defaultFlags } from './capability-metadata.js';
export type CapabilityFlags = Readonly<Required<BrokerConfigFlags>>;
export interface CapabilityDiagnostic {
  readonly capability: keyof BrokerConfigFlags | 'dom';
  readonly missing: readonly string[];
}
export interface CapabilityContext {
  readonly broker?: Partial<IBrokerTerminal>;
  readonly extensions?: LumenBrokerExtensions;
  readonly quoteMethods?: boolean;
  readonly depthMethods?: boolean;
  readonly domFeature?: boolean;
}
export interface CapabilityPolicy {
  readonly flags: CapabilityFlags;
  readonly orderTypes: readonly OrderType[];
  readonly durations: readonly OrderDurationMetaInfo[];
  readonly symbol: Readonly<SymbolSpecificTradingOptions>;
  readonly diagnostics: readonly CapabilityDiagnostic[];
  readonly dom: boolean;
  /** The broker streams pip values (`subscribePipValue`/`unsubscribePipValue`); otherwise money estimates use the static instrument pip value. */
  readonly pipValues: boolean;
}
const dependencies: Partial<Record<keyof BrokerConfigFlags, readonly (keyof IBrokerTerminal)[]>> = {
  supportPositions: ['positions'],
  supportPositionBrackets: ['editPositionBrackets'],
  supportIndividualPositionBrackets: ['editIndividualPositionBrackets'],
  supportPositionNetting: ['positions', 'individualPositions'],
  supportClosePosition: ['closePosition'],
  supportCloseIndividualPosition: ['closeIndividualPosition'],
  supportNativeReversePosition: ['reversePosition'],
  supportOrdersHistory: ['ordersHistory'],
  supportExecutions: ['executions'],
  supportPartialClosePosition: ['closePosition'],
  supportPartialCloseIndividualPosition: ['closeIndividualPosition'],
  supportMargin: ['subscribeMarginAvailable', 'unsubscribeMarginAvailable'],
  supportPlaceOrderPreview: ['previewOrder'],
  supportModifyOrderPreview: ['previewOrder'],
  supportLeverage: ['leverageInfo'],
  supportLeverageButton: ['setLeverage'],
};
function applyDefined<T extends object>(target: T, source?: Partial<T>): void {
  if (!source) return;
  for (const key of Object.keys(target) as (keyof T)[]) {
    if (source[key] !== undefined) target[key] = source[key] as T[keyof T];
  }
}
/** Config wins as a whole over the deprecated alias; runtime patches retain presence. */
export function normalizeBrokerConfig(config?: SingleBrokerMetaInfo, brokerConfig?: SingleBrokerMetaInfo): SingleBrokerMetaInfo {
  const selected = config ?? brokerConfig ?? { configFlags: {} };
  return { ...selected, configFlags: { ...selected.configFlags }, durations: selected.durations?.map(d => ({ ...d })), customUI: selected.customUI ? { ...selected.customUI } : undefined };
}

export function resolveCapabilities(
  config: SingleBrokerMetaInfo = { configFlags: {} },
  patch: Partial<BrokerConfigFlags> = {},
  symbolOptions: SymbolSpecificTradingOptions = {},
  context: CapabilityContext = {},
): CapabilityPolicy {
  const flags: Required<BrokerConfigFlags> = { ...defaultFlags };
  applyDefined(flags, config.configFlags);
  applyDefined(flags, patch);
  // Only declared symbol overrides may participate. New enabling options cannot widen order types.
  for (const key of Object.keys(flags) as (keyof BrokerConfigFlags)[]) {
    if (key in symbolOptions) {
      const value = symbolOptions[key as keyof SymbolSpecificTradingOptions];
      if (typeof value === 'boolean') flags[key] = value;
    }
  }
  if (!flags.supportStopLoss && !flags.supportTrailingStop && !flags.supportGuaranteedStop) flags.supportStopLoss = true;
  if (flags.supportPositionBrackets) flags.supportIndividualPositionBrackets = false;
  if (!flags.supportLeverage) flags.supportLeverageButton = false;
  const diagnostics: CapabilityDiagnostic[] = [];
  if (context.broker) {
    for (const [key, methods] of Object.entries(dependencies)) {
      const capability = key as keyof BrokerConfigFlags;
      if (!flags[capability]) continue;
      const missing = methods.filter(method => typeof context.broker?.[method] !== 'function');
      if (!missing.length) continue;
      diagnostics.push(Object.freeze({ capability, missing: Object.freeze(missing) }));
      flags[capability] = false;
    }
  }
  if (flags.supportPreviewClosePosition && !context.extensions?.previewClosePosition && !config.customUI?.showClosePositionDialog) {
    diagnostics.push(Object.freeze({ capability: 'supportPreviewClosePosition', missing: Object.freeze(['LumenBrokerExtensions.previewClosePosition']) }));
    flags.supportPreviewClosePosition = false;
    flags.supportClosePosition = false;
  }
  if (!flags.supportLeverage) flags.supportLeverageButton = false;
  let dom = flags.supportLevel2Data && !!context.domFeature;
  if (dom) {
    const missing = [];
    if (!context.quoteMethods) missing.push('quotes');
    if (!context.depthMethods) missing.push('depth');
    if (typeof context.broker?.cancelOrders !== 'function') missing.push('cancelOrders');
    if (missing.length) {
      diagnostics.push(Object.freeze({ capability: 'dom', missing: Object.freeze(missing) }));
      dom = false;
    }
  }
  const orderFlags: readonly [OrderType, keyof BrokerConfigFlags][] = [
    [OrderType.Market, 'supportMarketOrders'], [OrderType.Limit, 'supportLimitOrders'],
    [OrderType.Stop, 'supportStopOrders'], [OrderType.StopLimit, 'supportStopLimitOrders'],
  ];
  const orderTypes = orderFlags.filter(([type, flag]) => flags[flag] && (!symbolOptions.allowedOrderTypes || symbolOptions.allowedOrderTypes.includes(type))).map(([type]) => type);
  const durations = (config.durations ?? []).filter(duration => !symbolOptions.allowedDurations || symbolOptions.allowedDurations.includes(duration.value));
  const symbol = { supportBracketsInPips: true, supportModifyPositionBrackets: true, supportModifyOrderBrackets: true, supportRiskControlsAndInfo: true, ...structuredClone(symbolOptions) };
  const pipValues = typeof context.broker?.subscribePipValue === 'function' && typeof context.broker?.unsubscribePipValue === 'function';
  return Object.freeze({ flags: Object.freeze(flags), orderTypes: Object.freeze(orderTypes), durations: Object.freeze(durations.map(d => Object.freeze(structuredClone(d)))), symbol: Object.freeze(symbol), diagnostics: Object.freeze(diagnostics), dom, pipValues });
}
/** Durations are constrained by both the selected type and the resolved symbol policy. */
export function durationsForType(policy: CapabilityPolicy, type: OrderType): readonly OrderDurationMetaInfo[] {
  if (!policy.orderTypes.includes(type)) return [];
  return policy.durations.filter(duration => (duration.supportedOrderTypes ?? [OrderType.Limit, OrderType.Stop, OrderType.StopLimit]).includes(type));
}

/** Crypto exchange ticket mode: a symbol's own setting wins, then the broker-wide and per-type flags. */
export function cryptoTicketMode(policy: CapabilityPolicy, instrumentType?: string): boolean {
  if (policy.symbol.supportCryptoExchange !== undefined) return policy.symbol.supportCryptoExchange;
  return policy.flags.supportCryptoExchangeOrderTicket || (policy.flags.supportSymbolSpecificCryptoOrderTicket && instrumentType === 'crypto');
}

/** Netting brokers that bracket individual fills but not the net position show individual positions instead of net rows. */
export function showsIndividualPositions(
  flags: Pick<CapabilityFlags, "supportPositionNetting" | "supportIndividualPositionBrackets" | "supportPositionBrackets">,
): boolean {
  return flags.supportPositionNetting && flags.supportIndividualPositionBrackets && !flags.supportPositionBrackets;
}
