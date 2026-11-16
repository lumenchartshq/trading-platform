import { DialogBody } from "./dialog-body.js";
import { dialogTitle } from "./types.js";
import { CloseIcon } from "../icons.js";
import { TradingDialogPopupMount } from "../popup-mount.js";

import { Dialog } from "@kobalte/core/dialog";
import { Show, createSignal, onCleanup } from "solid-js";

import type { TradingSession } from "../../core/session.js";
import { TradingButton, useTradingValue } from "../primitives.js";

export function TradingDialogs(props: {
  session: TradingSession;
  mount: HTMLElement;
}) {
  let initiatingFocus: HTMLElement | undefined;
  const current = useTradingValue(
      props.session.dialogs.current,
      (previous, next) => {
        if (previous?.id !== next?.id) setBusy(false);
        if (
          next &&
          next.request.kind !== "order" &&
          next.request.kind !== "position"
        ) {
          const active = props.mount.ownerDocument.activeElement;
          if (active && "focus" in active)
            initiatingFocus = active as HTMLElement;
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
  return (
    <Dialog
      open={modal()}
      modal
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
            queueMicrotask(() => {
              const current = props.session.dialogs.current.get();
              if (
                (!current || current.request.kind === "order") &&
                target?.isConnected
              )
                target.focus();
            });
          }}
          class="trading-dialog"
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
