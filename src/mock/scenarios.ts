import type { InstrumentInfo, SingleBrokerMetaInfo } from '../contracts/broker.js';
import { OrderType } from '../contracts/broker.js';
export const simulationProfiles = ['equity-net', 'equity-estimates', 'fx-netting', 'fx-multiposition', 'crypto', 'custom-ui', 'failure-lab'] as const;
export type SimulationProfile = typeof simulationProfiles[number];
export function simulationInstrument(profile: SimulationProfile): InstrumentInfo {
  const forex = profile.startsWith('fx-');
  const crypto = profile === 'crypto';
  // One USD-quoted unit per quantity step, so a pip is worth exactly pipSize USD and money estimates match notional.
  const pipSize = forex ? 0.1 : 0.01;
  return {
    description: 'Simulated instrument', qty: { min: 1, max: 10000, step: 1, default: 2 },
    minTick: 0.01, pipSize, pipValue: pipSize,
    type: forex ? 'forex' : crypto ? 'crypto' : 'stock', currency: 'USD', baseCurrency: crypto ? 'SIM' : undefined,
    quoteCurrency: crypto ? 'USD' : undefined, marginRate: 0.1, leverage: '10', brokerSymbol: 'SIM:X',
    allowedOrderTypes: [OrderType.Market, OrderType.Limit, OrderType.Stop, OrderType.StopLimit],
  };
}
export function simulationConfig(profile: SimulationProfile): SingleBrokerMetaInfo {
  return {
    configFlags: {
      supportPLUpdate: profile !== 'equity-estimates',
      supportStopLimitOrders: true, supportOrderBrackets: true, supportPositionBrackets: profile !== 'fx-netting',
      supportIndividualPositionBrackets: profile === 'fx-netting', supportPositionNetting: profile === 'fx-netting',
      supportMultiposition: profile === 'fx-multiposition', supportClosePosition: true, supportCloseIndividualPosition: true,
      supportPartialClosePosition: true, supportPartialCloseIndividualPosition: true, supportReversePosition: true, supportNativeReversePosition: true,
      supportLevel2Data: true, supportMargin: true, supportLeverage: true, supportModifyDuration: true, supportModifyOrderType: true,
      supportTrailingStop: true, supportGuaranteedStop: true, supportMultipleExitLevels: true, supportUnpairedExitLevels: true,
      supportCryptoExchangeOrderTicket: profile === 'crypto', supportBalances: profile === 'crypto', supportCustomOrderInfo: true,
    },
    durations: [
      { name: 'Good until cancelled', value: 'GTC', default: true },
      { name: 'Good until date', value: 'GTD', hasDatePicker: true, hasTimePicker: true },
    ],
    tradedGroupConfig: { supportAdaptiveLayout: true },
  };
}
