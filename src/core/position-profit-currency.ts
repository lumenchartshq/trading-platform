import type { AccountMetainfo, InstrumentInfo, Position } from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { accountCurrency } from "./identity.js";

/** Where a position's money P&L is denominated: `positionPLInInstrumentCurrency` picks the instrument. */
export type PositionProfitCurrencySource = "instrument" | "account";

/** The currency of a position's money P&L; `currency` is undefined while it is unknown. */
export interface PositionProfitCurrency {
  readonly source: PositionProfitCurrencySource;
  readonly currency: string | undefined;
}

/** The broker's account list and the account to read from it. */
export interface ProfitAccount {
  readonly accounts: readonly Pick<AccountMetainfo, "id" | "currency">[] | undefined;
  readonly accountId: string | undefined;
}

export interface PositionProfitCurrencyContext extends ProfitAccount {
  readonly symbolPolicy: (symbol: string) => Pick<CapabilityPolicy, "flags">;
  /** The position symbol's instrument, once resolved. */
  readonly instrument: Pick<InstrumentInfo, "currency"> | undefined;
}

/**
 * The currency of a position's money P&L, for the position line and its TP/SL lines alike: the instrument currency
 * when the broker reports P&L in it, otherwise the currency of the account that owns the position.
 */
export function positionProfitCurrency(
  position: Pick<Position, "symbol">,
  context: PositionProfitCurrencyContext,
): PositionProfitCurrency {
  if (context.symbolPolicy(position.symbol).flags.positionPLInInstrumentCurrency)
    return { source: "instrument", currency: context.instrument?.currency };
  // The platform is single-account and a position names no account, so its owner is the given (current) account.
  // Resolving a position's own account later belongs here, which is why this takes the position.
  return { source: "account", currency: accountCurrency(context.accounts, context.accountId) };
}
