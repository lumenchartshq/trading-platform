import type { TradingChartBinding, TradingCollectionPort } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import type { TicketController } from "./order-ticket/controller.js";
import type { createDomWorkspace } from "./dom/workspace.js";
import { ticketPhaseOpen } from "./ticket-dock.js";

/** Broker panel requests settle back to the mounted state if the surface cannot open. */
export function bindPanelVisibility(
  session: TradingSession,
  collection: TradingCollectionPort,
  ticket: TicketController,
  dom: Pick<ReturnType<typeof createDomWorkspace>, "isVisible" | "hide" | "open">,
  open: (binding: TradingChartBinding) => Promise<void>,
  isDisposed: () => boolean,
): () => void {
  const domPanel = session.host.domPanelVisibility();
  const orderPanel = session.host.orderPanelVisibility();
  const activeChart = () => collection.activeChart() ?? collection.charts()[0];
  // A refused open (feature off, compact layout, no depth, no chart, stale account) writes the
  // real state back, so the value never sticks at true and a later broker write still applies.
  const domPanelChanged = (visible: boolean) => {
    if (!visible && dom.isVisible()) dom.hide();
    const chart = activeChart();
    if (visible && !dom.isVisible() && chart) dom.open(chart);
    if (visible && !dom.isVisible())
      queueMicrotask(() => domPanel?.setValue(dom.isVisible()));
  };
  const ticketOpen = () => ticketPhaseOpen(ticket.state.get().phase);
  const orderPanelChanged = (visible: boolean) => {
    if (!visible && ticketOpen()) ticket.close();
    if (!visible || ticketOpen()) return;
    const chart = activeChart();
    const settle = () => {
      if (!isDisposed()) orderPanel?.setValue(ticketOpen());
    };
    if (!chart || !session.features.order_panel) {
      queueMicrotask(settle);
      return;
    }
    void open(chart.binding.get()).then(() => queueMicrotask(settle));
  };
  domPanel?.subscribe(domPanelChanged);
  orderPanel?.subscribe(orderPanelChanged);
  return () => {
    domPanel?.unsubscribe(domPanelChanged);
    orderPanel?.unsubscribe(orderPanelChanged);
  };
}
