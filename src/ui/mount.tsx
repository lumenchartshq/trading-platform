import { userMessage } from "../core/errors.js";
import { createTicketProjection } from "./order-ticket/chart-projection.js";
import { sameAccountGeneration, sameBinding, bindingKey } from "../core/identity.js";
import { TicketShell } from "./ticket-shell.js";
import { QuoteControls } from "./chart-controls/quote-controls.js";
import { createChartActions } from "./chart-actions.js";
import { createTicketDock, isPositionPaneEntry, ticketPhaseOpen } from "./ticket-dock.js";
import { bindPanelVisibility } from "./panel-visibility.js";
import { NARROW_WIDTH } from "./layout.js";
import { valueReader } from "../core/readers.js";
import { ValueStore } from "../core/value-store.js";
import { createDockSizes } from "./dock-sizes.js";
import { bindSurfaceTheme } from "./surface-theme.js";
import { adoptSurfaceDocument } from "./host-document.js";
import { TradingPopupMount } from "./popup-mount.js";
import { createDomWorkspace } from "./dom/workspace.js";
import { Show } from "solid-js";
import { render } from "solid-js/web";
import { BottomWidgetBarMode, OrderType, Side } from "../contracts/broker.js";
import type { Order, PreOrder } from "../contracts/broker.js";
import type { TradingChartBinding, TradingChartPort, TradingCollectionPort, TradingPresentationPort } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import { DisposalScope } from "../core/disposal.js";
import { TradingError } from "../core/errors.js";
import { animationFrames } from "../chart/frame-batch.js";
import { createOverlayCoordinator } from "../chart/overlay-coordinator.js";
import { createTicketController } from "./order-ticket/controller.js";
import { AccountManagerWorkspace } from "./account-manager/workspace.js";
import { TradingDialogs } from "./dialogs/view.js";
import { TradingSymbolLogos } from "./symbol-logo.js";
import { TradingToasts } from "./notifications/toasts.js";
import {
  TRADING_SETTINGS_PAGE_ID,
  TRADING_SETTINGS_PAGE_LABEL,
  applyTradingSettings,
  subscribeTradingSettings,
  tradingSettingsSnapshot,
} from "../core/trading-settings.js";

export interface TradingMountOptions {
  readonly session: TradingSession;
  readonly collection: TradingCollectionPort;
  readonly presentation: TradingPresentationPort;
}
/** Owns mounted presentation only. The supplied session belongs to the consumer. */
export function mountTradingPlatform(options: TradingMountOptions) {
  const { session, collection, presentation } = options,
    scope = new DisposalScope(),
    ticket = createTicketController(session);
  const sizes = createDockSizes(session.preferences, () =>
    session.host.showNotification(
      "Panel size",
      "Your panel size could not be saved.",
    ),
  );
  scope.own(() => sizes.destroy());
  // Chart hosts show trading settings as a page of their own settings dialog.
  if (presentation.registerSettingsPage)
    scope.own(
      presentation.registerSettingsPage({
        id: TRADING_SETTINGS_PAGE_ID,
        label: TRADING_SETTINGS_PAGE_LABEL,
        snapshot: () => tradingSettingsSnapshot(session),
        apply(patch) {
          try {
            applyTradingSettings(session, patch);
          } catch (cause) {
            // Validation messages are written for users; storage and host failures are not.
            if (cause instanceof TradingError && cause.code === "invalid-input") throw cause;
            throw new Error("Your trading settings could not be saved.");
          }
          // Retry an earlier failed save too; report only a save that still fails.
          if (session.displaySettingsError.get()) session.updateDisplaySettings({});
          const failure = session.displaySettingsError.get();
          if (failure) throw new Error(failure);
        },
        subscribe: (listener) => subscribeTradingSettings(session, listener),
      }),
    );
  const openSettingsPage = presentation.openSettingsPage?.bind(presentation);
  if (openSettingsPage)
    scope.own(session.setSettingsOpener(() => openSettingsPage(TRADING_SETTINGS_PAGE_ID)));
  let ticketElement: HTMLElement | undefined;
  let popupMountElement: HTMLElement | undefined;
  let nextTicketInitiator: HTMLElement | undefined;
  const ticketVisibility = new ValueStore(true);
  const symbolLogos = presentation.symbolLogos?.bind(presentation);
  const { isOpen: ticketDockOpen, isTicketOpen, syncTicketDock } = createTicketDock(session, ticket, presentation, () => sizes.right.get());
  scope.own(() => ticketVisibility.destroy());
  const dom = createDomWorkspace({
    session,
    collection,
    presentation,
    sizes,
    compactTicket: (chart, qty) =>
      open(chart.binding.get(), qty === undefined ? {} : { qty }),
    visibility: (visible) => {
      session.host.domPanelVisibility()?.setValue(visible);
      ticketVisibility.set(!visible);
      if (ticketElement) ticketElement.hidden = visible;
      if (!visible)
        syncTicketDock();
    },
  });
  scope.own(() => dom.destroy());
  scope.own(
    sizes.right.subscribe(() => {
      if (ticketDockOpen() && !dom.isVisible()) syncTicketDock();
    }),
  );
  const controls = new Map<string, { destroy(): void }>();
  let disposed = false,
    openedRequest: number | undefined;
  const error = (cause: unknown) => {
    if (!disposed)
      session.host.showNotification(
        "Trading action unavailable",
        userMessage(cause, "Try again."),
      );
  };
  function surface(
    kind: "ticket" | "accounts" | "dialogs",
    mount: (element: HTMLElement, popups: HTMLElement | undefined) => () => void,
  ): void {
    const owned = presentation.acquireSurface(kind);
    owned.element.classList.add("lumen-trading");
    if (kind === "ticket") ticketElement = owned.element;
    if (kind === "dialogs") popupMountElement = owned.element;
    scope.own(owned.release);
    // A host-placed surface (another document) gets its own event delegation and popup layer.
    const hosted = adoptSurfaceDocument(owned.element, document);
    scope.own(hosted.release);
    scope.own(bindSurfaceTheme(owned.element, presentation.environment));
    if (hosted.popupMount) scope.own(bindSurfaceTheme(hosted.popupMount, presentation.environment));
    // Popups position against their own document: a surface reuses the dialogs layer only when the two share one.
    const sharedPopups =
      popupMountElement?.ownerDocument === owned.element.ownerDocument ? popupMountElement : undefined;
    scope.own(mount(owned.element, hosted.popupMount ?? sharedPopups));
  }
  function open(
    binding: TradingChartBinding,
    template: Partial<PreOrder> | Order = {},
    initiator?: HTMLElement,
  ): Promise<void> {
    const currentTicket = ticket.state.get();
    if ("id" in template && "id" in currentTicket.order && template.id === currentTicket.order.id && currentTicket.phase !== "closed" && session.chartEdits.state.get()?.id === template.id) {
      ticket.patch(template);
      return new Promise<void>(resolve => {
        const release = ticket.state.subscribe(next => {
          if (["closed", "confirmed", "unconfirmed"].includes(next.phase)) { release(); resolve(); }
        });
      });
    }
    if (currentTicket.phase !== "closed") ticket.close();
    const connection = session.state.connection.get();
    const boundAtStart = collection.charts().some((chart) => {
      const current = chart.binding.get();
      return (
        sameBinding(current, binding)
      );
    });
    const active = initiator ?? ticketElement?.ownerDocument.activeElement;
    const captured =
      active && "focus" in active ? (active as HTMLElement) : undefined;
    return session.host
      .getQty(binding.symbol)
      .then((qty) => {
        const current = session.state.connection.get();
        if (
          disposed ||
          current.phase !== "ready" ||
          !sameAccountGeneration(current, connection)
        )
          return;
        if (
          boundAtStart &&
          !collection.charts().some((chart) => {
            const current = chart.binding.get();
            return (
              sameBinding(current, binding) &&
              current.symbol === binding.symbol
            );
          })
        )
          return;
        nextTicketInitiator = captured;
        return session.showOrderTicket(binding, {
          symbol: binding.symbol,
          side: Side.Buy,
          type: OrderType.Market,
          qty,
          ...template,
        });
      })
      .finally(() => {
        if (nextTicketInitiator === captured) nextTicketInitiator = undefined;
      })
      .then(() => undefined, error);
  }
  const { bindingFor, intent, overlayAction, positionAction } = createChartActions(session, collection, open);
  try {
    scope.own(() => ticket.destroy());
    surface("dialogs", (element) =>
      render(
        () => (
          <TradingSymbolLogos.Provider value={symbolLogos}>
            <TradingDialogs session={session} mount={element} />
            <Show when={session.features.trading_notifications}>
              <TradingToasts session={session} />
            </Show>
          </TradingSymbolLogos.Provider>
        ),
        element,
      ),
    );
    surface("ticket", (element, popups) =>
      render(
        () => (
          <TradingPopupMount.Provider value={popups}>
            <TicketShell
              sizes={sizes}
              session={session}
              controller={ticket}
              presentation={presentation}
              element={element}
              visibility={ticketVisibility}
              requestSymbol={(symbol) => {
                const binding = ticket.state.get().binding;
                collection
                  .charts()
                  .find((chart) => chart.binding.get().id === binding?.id)
                  ?.requestSymbol?.(symbol);
              }}
              changeSymbol={(symbol) => {
                const draft = ticket.state.get().order;
                // Settle the open ticket request first; a new one would otherwise queue behind it.
                ticket.close();
                open(bindingFor(symbol), draft ? { side: draft.side, type: draft.type } : {});
              }}
              takeInitiator={() => {
                const target = nextTicketInitiator;
                nextTicketInitiator = undefined;
                return target;
              }}
            />
          </TradingPopupMount.Provider>
        ),
        element,
      ),
    );
    if (
      !session.features.open_account_manager ||
      !session.features.trading_account_manager
    )
      session.host.setAccountManagerVisibilityMode(
        BottomWidgetBarMode.Minimized,
      );
    if (!session.features.trading_account_manager)
      presentation.setDockSize("accounts", 0);
    if (session.features.trading_account_manager)
      surface("accounts", (element, popups) =>
        render(
          () => (
            <TradingPopupMount.Provider value={popups}>
              <TradingSymbolLogos.Provider value={symbolLogos}>
              <AccountManagerWorkspace
                sizes={sizes}
                session={session}
                presentation={presentation}
                collection={collection}
                onTrade={(binding, initiator) => open(binding, {}, initiator)}
                onDepth={() => {
                  const chart = collection.activeChart() ?? collection.charts()[0];
                  if (chart) dom.open(chart);
                }}
                onOrderAction={(id) => {
                  const order = session.state.orders.get(id);
                  if (order) open(bindingFor(order.symbol), order);
                }}
                onPositionAction={positionAction}
              />
              </TradingSymbolLogos.Provider>
            </TradingPopupMount.Provider>
          ),
          element,
        ),
      );
    const applyDialog = (
      entry: ReturnType<typeof session.dialogs.current.get>,
    ) => {
      if (entry?.request.kind !== "order" || entry.id === openedRequest) return;
      openedRequest = entry.id;
      void ticket
        .open(
          entry.request.binding ?? bindingFor(entry.request.order.symbol),
          entry.request.order,
        )
        .catch(error);
    };
    scope.own(session.dialogs.current.subscribe(applyDialog));
    let positionPaneOpen = false;
    scope.own(
      session.dialogs.current.subscribe((entry) => {
        const open = isPositionPaneEntry(entry);
        if (open === positionPaneOpen) return;
        positionPaneOpen = open;
        // A new protection pane must reveal its chart even when a previous ticket still occupies the dock.
        session.host.orderPanelVisibility()?.setValue(isTicketOpen() || open, open);
        if (open) dom.hide();
        syncTicketDock();
      }),
    );
    applyDialog(session.dialogs.current.get());
    // Dock width follows the sizes subscription; only the open/closed transition resizes it here.
    let ticketWasOpen = isTicketOpen();
    scope.own(
      ticket.state.subscribe((value) => {
        const ticketOpen = ticketPhaseOpen(value.phase);
        session.host.orderPanelVisibility()?.setValue(ticketOpen || positionPaneOpen);
        if (ticketOpen) dom.hide();
        if (ticketOpen !== ticketWasOpen) {
          ticketWasOpen = ticketOpen;
          syncTicketDock();
        }
        if (openedRequest === undefined) return;
        if (
          value.phase === "confirmed" ||
          value.phase === "unconfirmed" ||
          value.phase === "closed"
        ) {
          const id = openedRequest;
          openedRequest = undefined;
          session.dialogs.respond(id, value.phase !== "closed");
        }
      }),
    );
    const narrowLines = new ValueStore(presentation.environment.get().width < NARROW_WIDTH);
    scope.own(() => narrowLines.destroy());
    scope.own(
      presentation.environment.subscribe((value) =>
        narrowLines.set(value.width < NARROW_WIDTH),
      ),
    );
    const overlay = createOverlayCoordinator(
      session,
      collection,
      overlayAction,
      error,
      valueReader(narrowLines),
      animationFrames(),
    );
    scope.own(() => overlay.destroy());
    const projection = createTicketProjection(session, collection, ticket, () => ticketElement?.querySelector<HTMLInputElement>('[data-ui="order-quantity-input"]')?.focus());
    scope.own(() => projection.destroy());
    function add(chart: TradingChartPort): void {
      const binding = chart.binding.get(),
        key = bindingKey(binding);
      if (controls.has(key)) return;
      const owned = presentation.acquireSurface("chart-controls", binding);
      owned.element.classList.add("lumen-trading");
      const local = new DisposalScope();
      local.own(owned.release);
      local.own(bindSurfaceTheme(owned.element, presentation.environment));
      controls.set(key, { destroy: () => local.destroy() });
      local.own(
        render(
          () => (
            <QuoteControls
              session={session}
              chart={chart}
              visible={owned.visible}
              open={open}
              depth={() => dom.open(chart)}
            />
          ),
          owned.element,
        ),
      );
      local.own(
        chart.onTradeIntent((value) => {
          void intent(value).catch(error);
        }),
      );
    }
    for (const chart of collection.charts()) add(chart);
    scope.own(bindPanelVisibility(session, collection, ticket, dom, open, () => disposed));
    // show_order_panel_on_start opens one ticket for the active chart once the account is first ready.
    if (
      session.features.show_order_panel_on_start &&
      session.features.order_panel
    ) {
      let release: (() => void) | undefined;
      const openOnStart = () => {
        if (session.state.connection.get().phase !== "ready") return;
        release?.();
        release = undefined;
        const chart = collection.activeChart() ?? collection.charts()[0];
        if (chart && ticket.state.get().phase === "closed")
          open(chart.binding.get());
        return true;
      };
      if (!openOnStart()) {
        release = session.state.connection.subscribe(() => {
          openOnStart();
        });
        scope.own(() => release?.());
      }
    }
    scope.own(
      collection.subscribe((event) => {
        if (event.type === "added") add(event.chart);
        if (event.type === "removed" || event.type === "bindingChanged") {
          const binding =
              event.type === "removed" ? event.binding : event.previous,
            key = bindingKey(binding);
          const edit = session.chartEdits.state.get();
          if (edit && sameBinding(edit.binding, binding)) {
            const dialog = session.dialogs.current.get();
            if (dialog?.request.kind === "position" && dialog.request.position.id === edit.id) session.dialogs.respond(dialog.id, false);
            session.chartEdits.clear();
          }
          controls.get(key)?.destroy();
          controls.delete(key);
          if (
            sameBinding(ticket.state.get().binding, binding)
          )
            ticket.close();
          if (event.type === "bindingChanged") {
            const chart = collection
              .charts()
              .find((value) => value.binding.get().id === event.binding.id);
            if (chart) add(chart);
          }
        }
      }),
    );
    return { destroy };
  } catch (cause) {
    try {
      destroy();
    } catch {
      /* Keep the mounting error while releasing remaining resources. */
    }
    throw cause;
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    let first: unknown;
    for (const control of controls.values()) {
      try {
        control.destroy();
      } catch (cause) {
        first ??= cause;
      }
    }
    controls.clear();
    try {
      scope.destroy();
    } catch (cause) {
      first ??= cause;
    }
    if (first !== undefined) throw first;
  }
}
