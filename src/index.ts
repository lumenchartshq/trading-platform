export { resolveCapabilities, normalizeBrokerConfig, durationsForType, defaultFlags } from './core/capabilities.js';
export type { CapabilityPolicy, CapabilityFlags, CapabilityContext, CapabilityDiagnostic } from './core/capabilities.js';
export { createTradingSession } from './core/session.js';
export type { TradingSession } from './core/session.js';
export type { TradingSessionOptions } from './core/session-types.js';
export type { TradingCommandContext, PlaceRequest, ModifyRequest, EntityRequest } from './core/trading-commands.js';
export type { TradingCommandResult } from './core/command-coordinator.js';
export { TradingError } from './core/errors.js';
export type { TradingErrorCode } from './core/errors.js';

export { resolveTradingFeatures, tradingFeatureDefaults } from './core/features.js';
export type { TradingFeature, TradingFeatures } from './core/features.js';

export { createDefaultTradingFormatters, createNumericFormatter, createPriceFormatter } from './compat/default-formatters.js';

export { positionProfit, riskBudget, quantityForRisk, executablePrice, liquidationPrice, orderEntryPrice, cryptoBaseQuantity, cryptoQuoteAmount, orderNotional, marginRequired } from './core/financial-rules.js';
export type { ProfitDisplayMode } from './core/financial-rules.js';

export type { LeverageRequest, LeverageChangeRequest, LeverageReview } from './core/leverage-commands.js';
