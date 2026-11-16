import type { TradingPresentationPort } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import type { TicketController } from "./order-ticket/controller.js";

/** A ticket phase that occupies the dock. */
export const ticketPhaseOpen = (phase: string): boolean => phase !== "closed";
/** A dialog entry that is the position protection side pane. */
export const isPositionPaneEntry = (entry: { readonly request: { readonly kind: string } } | undefined): boolean =>
  entry?.request.kind === "position";

/** One dock hosts both order tickets and the position protection side pane. */
export function createTicketDock(
  session: TradingSession,
  ticket: TicketController,
  presentation: TradingPresentationPort,
  width: () => number,
) {
  const isTicketOpen = () => ticketPhaseOpen(ticket.state.get().phase);
  const isPositionPaneOpen = () => isPositionPaneEntry(session.dialogs.current.get());
  const isOpen = () => isTicketOpen() || isPositionPaneOpen();
  const syncTicketDock = () => presentation.setDockSize("ticket", isOpen() ? width() : 0);
  return { isOpen, isTicketOpen, isPositionPaneOpen, syncTicketDock };
}
