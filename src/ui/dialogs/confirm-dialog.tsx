import { For, Show } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import type { TradingSession } from "../../core/session.js";
import { SymbolLogo } from "../symbol-logo.js";
import { TradingButton } from "../primitives.js";
import type { DialogRequest } from "./types.js";
export function ConfirmDialog(props: {
  request: DialogRequest<"confirm">;
  session: TradingSession;
  complete(approved: boolean): void;
}) {
  const logo = () => {
    const symbol = props.request.symbol;
    if (!symbol) return false;
    return symbol.logo === "cancel"
      ? props.session.features.show_symbol_logo_in_cancel_order_dialog
      : props.session.features.show_symbol_logo_in_close_position_dialog;
  };
  return <>
    <Show when={props.request.symbol}>
      {symbol => <SymbolLogo symbol={symbol().name} enabled={logo()} />}
    </Show>
    <Dialog.Description class="trading-dialog-lines">
      <For each={Array.isArray(props.request.content) ? props.request.content : [props.request.content]}>
        {line => <span>{line}</span>}
      </For>
    </Dialog.Description>
    <div class="trading-actions">
      <TradingButton onClick={() => props.complete(false)}>{props.request.cancelButtonText ?? "Cancel"}</TradingButton>
      <TradingButton tone="primary" onClick={() => props.complete(true)}>{props.request.mainButtonText ?? "Confirm"}</TradingButton>
    </div>
  </>;
}
