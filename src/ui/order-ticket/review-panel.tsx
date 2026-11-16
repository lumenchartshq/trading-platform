import { For, Show } from "solid-js";
import { Side } from "../../contracts/broker.js";
import type { OrderPreviewResult, PreOrder } from "../../contracts/broker.js";
import { TradingButton } from "../primitives.js";
import { PreviewMessage } from "./preview-message.js";
import { typeName } from "./rules.js";
export function ReviewPanel(props: {
  order: Readonly<PreOrder>; displaySymbol: string; preview?: OrderPreviewResult; unavailable: boolean;
  titleRef(element: HTMLHeadingElement): void; edit(): void; send(): Promise<void>;
}) {
  return (
    <div class="trading-confirmation">
      <h3 ref={props.titleRef} tabIndex={-1}>
        Review your order
      </h3>
      <p>
        {props.order.side === Side.Buy ? "Buy" : "Sell"} {props.order.qty}{" "}
        {props.displaySymbol} · {typeName(props.order.type)}
      </p>
      <For each={props.preview?.sections}>
        {(section) => (
          <section>
            <Show when={section.header}>
              <h4>{section.header}</h4>
            </Show>
            <dl>
              <For each={section.rows}>
                {(row) => (
                  <div>
                    <dt>{row.title}</dt>
                    <dd>{row.value}</dd>
                  </div>
                )}
              </For>
            </dl>
          </section>
        )}
      </For>
      <For each={props.preview?.warnings}>
        {(message) => (
          <p class="trading-warning">
            <PreviewMessage value={message} />
          </p>
        )}
      </For>
      <For each={props.preview?.errors}>
        {(message) => (
          <p role="alert" class="trading-error">
            <PreviewMessage value={message} />
          </p>
        )}
      </For>
      <div class="trading-actions">
        <TradingButton onClick={props.edit}>Edit order</TradingButton>
        <TradingButton
          tone="primary"
          disabled={!!props.preview?.errors?.length || props.unavailable}
          onClick={() => {
            void props.send();
          }}
        >
          Send order
        </TradingButton>
      </div>
    </div>
  );
}
