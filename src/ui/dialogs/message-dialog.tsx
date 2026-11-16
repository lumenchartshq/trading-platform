import { Show, createEffect, onCleanup } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { TradingButton } from "../primitives.js";
import { sanitizedMessage } from "./sanitize-html.js";
import type { DialogRequest } from "./types.js";
export function MessageDialog(props: {
  request: DialogRequest<"message">;
  document: Document;
  complete(approved: boolean): void;
}) {
  let content: HTMLDivElement | undefined;
  createEffect(() => {
    if (!content || !props.request.html) return;
    content.replaceChildren(sanitizedMessage(props.document, props.request.content));
    onCleanup(() => content?.replaceChildren());
  });
  return <>
    <Show when={props.request.html} fallback={<Dialog.Description>{props.request.content}</Dialog.Description>}>
      <div ref={content} />
    </Show>
    <TradingButton onClick={() => props.complete(true)}>OK</TradingButton>
  </>;
}
