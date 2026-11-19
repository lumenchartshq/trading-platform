import { DialogBody } from "./dialog-body.js";
import { dialogTitle } from "./types.js";
import { CloseIcon } from "../icons.js";
import { TradingDialogPopupMount } from "../popup-mount.js";
import { focusedElement, isolateLayer } from "../host-document.js";
import { TAB_CANDIDATES, isTabCandidate, trapTab } from "../trap-tab.js";

import { Dialog } from "@kobalte/core/dialog";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import type { TradingSession } from "../../core/session.js";
import { TradingButton, useTradingValue } from "../primitives.js";

export function TradingDialogs(props: {
  session: TradingSession;
  mount: HTMLElement;
}) {
  let initiatingFocus: HTMLElement | undefined;
  // A control that starts a request may disable itself (a row's Close), dropping focus to the body before the dialog
  // opens; the last control that had focus is then the opener.
  const hostDocument = props.mount.ownerDocument;
  let lastFocused: HTMLElement | undefined;
  const trackFocus = (event: FocusEvent) => {
    // Shape, not instanceof: hosted panels are built from templates of the chart frame's realm.
    const target = event.target as Partial<HTMLElement> | null;
    if (
      target?.nodeType === 1 &&
      typeof target.focus === "function" &&
      target !== hostDocument.body &&
      !props.mount.contains(target as Node)
    )
      lastFocused = target as HTMLElement;
  };
  hostDocument.addEventListener("focusin", trackFocus, true);
  onCleanup(() => hostDocument.removeEventListener("focusin", trackFocus, true));
  /** The control that opened a dialog: the focused one, or the last focused one when focus fell to the body. */
  const opener = (): HTMLElement | undefined => {
    const focused = focusedElement(hostDocument);
    if (focused && focused !== hostDocument.body && !props.mount.contains(focused)) return focused;
    return lastFocused?.isConnected ? lastFocused : undefined;
  };
  const current = useTradingValue(
      props.session.dialogs.current,
      (previous, next) => {
        if (previous?.id !== next?.id) setBusy(false);
        if (
          next &&
          next.request.kind !== "order" &&
          next.request.kind !== "position"
        ) {
          // Focus returns to the control that opened the dialog, also when it sits in the chart frame.
          initiatingFocus = opener();
        }
      },
    ),
    [busy, setBusy] = createSignal(false);
  const request = () => current()?.request;
  // Order tickets and position protection are side panes on the ticket surface, not modals.
  const modal = () =>
    request() !== undefined &&
    request()?.kind !== "order" &&
    request()?.kind !== "position";
  const title = () => dialogTitle(request());
  const [closing, setClosing] = createSignal(false);
  const window = props.mount.ownerDocument.defaultView;
  let closeTimer: number | undefined;
  onCleanup(() => {
    if (closeTimer !== undefined) window?.clearTimeout(closeTimer);
  });
  const complete = (approved: boolean) => {
    const value = current();
    if (!value) return;
    // Authoritative acknowledgements may dismiss between the two native clicks.
    // Keep their second click away from the chart/table without delaying completion.
    setClosing(!!window);
    if (closeTimer !== undefined) window?.clearTimeout(closeTimer);
    closeTimer = window?.setTimeout(() => {
      closeTimer = undefined;
      setClosing(false);
    }, 180);
    props.session.dialogs.respond(value.id, approved);
  };
  let dialogContent: HTMLElement | undefined;
  // In a host page's layer, Kobalte's modal behaviour reads the chart frame's document, so the dialog keeps its own:
  // aria-modal, a Tab trap, focus moved inside, and the rest of the page isolated. In the chart, Kobalte does this.
  const hostedLayer = props.mount.ownerDocument !== document;
  /** Focus goes back to the control that opened the dialog, unless another trading dialog has taken over. */
  const returnFocus = (target: HTMLElement | undefined, retry = true) => {
    const current = props.session.dialogs.current.get();
    if (current && current.request.kind !== "order") return;
    if (!target?.isConnected) return;
    target.focus();
    // A control that disabled itself for its request may only be enabled again a frame later.
    if (retry && target.ownerDocument.activeElement !== target)
      target.ownerDocument.defaultView?.requestAnimationFrame(() => returnFocus(target, false));
  };
  createEffect(() => {
    if (!hostedLayer || !modal()) return;
    // Record the opener before isolating the page: making it inert blurs the control that opened the dialog.
    initiatingFocus = opener();
    const restore = isolateLayer(props.mount);
    queueMicrotask(() => {
      const content = dialogContent;
      if (!content || content.contains(props.mount.ownerDocument.activeElement)) return;
      const first = [...content.querySelectorAll<HTMLElement>(TAB_CANDIDATES)].find(isTabCandidate);
      (first ?? content).focus();
    });
    onCleanup(() => {
      // The page must stop being inert before its control can take focus back.
      const target = initiatingFocus;
      restore();
      queueMicrotask(() => returnFocus(target));
    });
  });
  return (
    <Dialog
      open={modal()}
      modal={!hostedLayer}
      onOpenChange={(open) => {
        if (!open && !busy()) complete(false);
      }}
    >
      <Dialog.Portal mount={props.mount}>
        <Dialog.Overlay class="trading-dialog-backdrop" />
        <Dialog.Content
          ref={(element) => {
            dialogContent = element;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = initiatingFocus;
            queueMicrotask(() => returnFocus(target));
          }}
          class="trading-dialog"
          aria-modal={hostedLayer ? "true" : undefined}
          tabIndex={-1}
          onKeyDown={(event: KeyboardEvent) => {
            if (hostedLayer && dialogContent) trapTab(event, dialogContent);
          }}
          onEscapeKeyDown={(event) => {
            if (busy()) event.preventDefault();
          }}
        >
          <TradingDialogPopupMount.Provider value={() => dialogContent}>
          <header class="trading-panel-header">
            <Dialog.Title>{title()}</Dialog.Title>
            <TradingButton
              aria-label="Close dialog"
              class="trading-icon-button"
              disabled={busy()}
              onClick={() => complete(false)}
            >
              <CloseIcon />
            </TradingButton>
          </header>
          <Show when={current()} keyed>
            {(entry) => (
              <DialogBody request={entry.request} session={props.session}
                document={props.mount.ownerDocument} complete={complete} busy={setBusy}
                approveAmount={amount => props.session.dialogs.respondAmount(entry.id, amount)} />
            )}
          </Show>
          </TradingDialogPopupMount.Provider>
        </Dialog.Content>
      </Dialog.Portal>
      <Show when={closing() && !modal()}>
        <div
          class="trading-dialog-click-shield"
          aria-hidden="true"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </Show>
    </Dialog>
  );
}
