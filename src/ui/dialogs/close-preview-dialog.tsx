import { For, Show } from "solid-js";
import { TradingButton } from "../primitives.js";
import { PreviewMessage } from "../order-ticket/preview-message.js";
import type { DialogRequest } from "./types.js";
export function ClosePreviewDialog(props: {
  request: DialogRequest<"closePreview">;
  complete(approved: boolean): void;
}) {
  return <>
    <dl>
      <For each={props.request.preview.rows}>
        {row => "type" in row ? <hr /> : <div><dt>{row.title}</dt><dd>{row.value} {row.currency}</dd></div>}
      </For>
    </dl>
    <Show when={props.request.preview.disclaimer}>
      {disclaimer => <p><PreviewMessage value={disclaimer()} /></p>}
    </Show>
    <div class="trading-actions">
      <TradingButton onClick={() => props.complete(false)}>Cancel</TradingButton>
      <TradingButton tone="primary" onClick={() => props.complete(true)}>Close position</TradingButton>
    </div>
  </>;
}
