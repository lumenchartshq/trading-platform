import { createTicketPlacement } from "./order-ticket/placement.js";
import { TicketLayoutContext } from "./order-ticket/layout-context.js";
import type { DockSizes } from "./dock-sizes.js";
import { ResizeHandle } from "./resize-handle.js";
import { COMPACT_WIDTH } from "./layout.js";
import { trapTab } from "./trap-tab.js";
import { Dialog } from "@kobalte/core/dialog";
import { Show, onCleanup } from "solid-js";
import type { ReadonlyValue, TradingPresentationPort } from "../contracts/ports.js";
import type { TradingSession } from "../core/session.js";
import type { TicketController } from "./order-ticket/controller.js";
import { OrderTicketView } from "./order-ticket/view.js";
import { PositionProtection } from "./dialogs/position-protection.js";
import type { TradingDialogRequest } from "../core/dialog-coordinator.js";
import { TradingDialogPopupMount } from "./popup-mount.js";
import { useTradingValue } from "./primitives.js";
import { isPositionPaneEntry, ticketPhaseOpen } from "./ticket-dock.js";
export function TicketShell(props: {
  sizes: DockSizes;
  session: TradingSession;
  controller: TicketController;
  presentation: TradingPresentationPort;
  element: HTMLElement;
  takeInitiator(): HTMLElement | undefined;
  visibility: ReadonlyValue<boolean>;
  requestSymbol?: (symbol: string) => void;
  changeSymbol?: (symbol: string) => void;
}) {
  const placement = createTicketPlacement(
    props.presentation,
    props.session.preferences,
    () => {
      props.session.host.showNotification(
        "Order ticket",
        "Your panel layout could not be saved.",
      );
    },
  );
  let content: HTMLElement | undefined;
  const placementState = useTradingValue(placement.state, (previous, next) => {
    const active = props.element.ownerDocument.activeElement;
    if (
      previous.floating &&
      !next.floating &&
      content?.isConnected &&
      content.contains(active) &&
      active?.getAttribute("data-ui") === "trading-ticket-move"
    )
      content.focus({ preventScroll: true });
  });
  const surfaceVisible = useTradingValue(props.visibility);
  const modalRequest = useTradingValue(props.session.dialogs.current);
  const paneRequest = () => {
    const entry = modalRequest();
    return isPositionPaneEntry(entry) ? entry : undefined;
  };
  const sidePane = (kind?: string) =>
    !kind || kind === "order" || kind === "position";
  const canInteract = () =>
    surfaceVisible() && sidePane(modalRequest()?.request.kind);
  const canMove = () => placementState().floating && canInteract();
  onCleanup(placement.destroy);
  let initiatingFocus: HTMLElement | undefined;
  const restoreFocus = () => {
    const target = initiatingFocus;
    const restore = () => {
      if (
        props.controller.state.get().phase === "closed" &&
        target?.isConnected
      )
        target.focus();
    };
    const window = props.element.ownerDocument.defaultView;
    if (window?.requestAnimationFrame) window.requestAnimationFrame(restore);
    else queueMicrotask(restore);
  };
  const width = useTradingValue(props.sizes.right);
  const compact = () => environment().width < COMPACT_WIDTH;
  const ticket = useTradingValue(props.controller.state, (previous, next) => {
      if (next.phase === "loading" && previous.revision !== next.revision) {
        const active =
          props.takeInitiator() ?? props.element.ownerDocument.activeElement;
        if (active && "focus" in active)
          initiatingFocus = active as HTMLElement;
      }
      if (ticketPhaseOpen(previous.phase) && !ticketPhaseOpen(next.phase))
        restoreFocus();
    }),
    environment = useTradingValue(props.presentation.environment);
  return (
    <Dialog
      open={ticketPhaseOpen(ticket().phase) || !!paneRequest()}
      // The host reparents this surface between dock, float and full screen, which breaks Kobalte's
      // modal hide-outside (it hid <body>). Compact screens get aria-modal plus a local focus trap instead.
      modal={false}
      onOpenChange={(open) => {
        if (open) return;
        const pane = paneRequest();
        if (pane) {
          props.session.dialogs.respond(pane.id, false);
          return;
        }
        const request = props.session.dialogs.current.get()?.request;
        if (!request || request.kind === "order") props.controller.close();
      }}
    >
      <Dialog.Content
        ref={(element) => {
          content = element;
        }}
        class="trading-ticket-shell"
        data-floating={placementState().floating}
        aria-label="Order ticket"
        aria-modal={compact() ? "true" : undefined}
        onKeyDown={(event: KeyboardEvent) => {
          if (compact() && content) trapTab(event, content);
        }}
        onInteractOutside={(event) => {
          const request = props.session.dialogs.current.get()?.request;
          // A desktop dock remains open while the chart or another dialog has
          // focus. Compact modal tickets retain their normal outside dismissal.
          if (
            environment().width >= COMPACT_WIDTH ||
            (request && !sidePane(request.kind))
          )
            event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <ResizeHandle
        class="trading-dock-resizer"
          axis="width"
          label="Resize order panel"
          value={width()}
          min={280}
          max={480}
          disabled={
            environment().width < COMPACT_WIDTH ||
            placementState().floating ||
            !canInteract()
          }
          resize={(value) => props.sizes.resize("right", value)}
          save={() => props.sizes.save("right")}
        />
        <Dialog.Title class="trading-visually-hidden">
          Order ticket
        </Dialog.Title>
        <TradingDialogPopupMount.Provider
          value={() => (environment().width < COMPACT_WIDTH ? content : undefined)}
        >
        <TicketLayoutContext.Provider
          value={{ placement, state: placementState, canMove }}
        >
          <div class="trading-ticket-pane" hidden={!!paneRequest()}>
            <OrderTicketView
              requestSymbol={props.requestSymbol}
              searchSymbolsPage={props.presentation.searchSymbolsPage?.bind(props.presentation)}
              searchSymbols={props.presentation.searchSymbols?.bind(props.presentation)}
              changeSymbol={props.changeSymbol}
              active={surfaceVisible() && !paneRequest()}
              session={props.session}
              controller={props.controller}
              locale={environment().locale}
              timezone={environment().timezone}
            />
          </div>
          <Show when={paneRequest()} keyed>
            {(entry) => (
              <PositionProtection
                session={props.session}
                request={
                  entry.request as Extract<
                    TradingDialogRequest,
                    { kind: "position" }
                  >
                }
                complete={(approved) =>
                  props.session.dialogs.respond(entry.id, approved)
                }
                busy={() => {}}
              />
            )}
          </Show>
        </TicketLayoutContext.Provider>
        </TradingDialogPopupMount.Provider>
      </Dialog.Content>
    </Dialog>
  );
}
