import type { TradingSession } from "./session.js";

type ReviewSession = Pick<
  TradingSession,
  "host" | "confirmationRequired" | "hasCustomOrderDialog" | "hasCustomPositionDialog" | "ticketSettings" | "symbolPolicy"
>;

/**
 * Chart Buy/Sell and price moves place orders directly only when the user chose silent placement
 * and nothing forces a dialog.
 */
export function placesOrdersWithoutTicket(session: ReviewSession): boolean {
  return session.host.silentOrdersPlacement().value() && !session.confirmationRequired && !session.hasCustomOrderDialog;
}
/** Chart TP/SL edits on positions skip the protection dialog under the same rule, with the broker's position dialog. */
export function editsPositionsWithoutDialog(session: ReviewSession): boolean {
  return (
    session.host.silentOrdersPlacement().value() && !session.confirmationRequired && !session.hasCustomPositionDialog
  );
}
/**
 * The broker previews this ticket: it supports previews for placing (or modifying) on the symbol and the
 * user kept "Show order preview" on. Without broker support the preference has no effect, as in the reference.
 */
export function ticketShowsPreview(session: ReviewSession, symbol: string, modifying: boolean): boolean {
  const flags = session.symbolPolicy(symbol).flags;
  const supported = modifying ? flags.supportModifyOrderPreview : flags.supportPlaceOrderPreview;
  return !!supported && session.ticketSettings.get().showOrderPreview;
}
/** The ticket sends without a review step unless confirmation is forced or the broker previews the order. */
export function ticketSkipsReview(session: ReviewSession, symbol: string, modifying: boolean): boolean {
  return !session.confirmationRequired && !ticketShowsPreview(session, symbol, modifying);
}
