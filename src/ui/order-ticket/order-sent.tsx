import { TradingButton } from "../primitives.js";
export function OrderSent(props: { summary: string; startNext(): void }) {
  return (
    <div class="trading-success" data-ui="order-sent">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="m7.5 12.5 3 3 6-6.5" />
      </svg>
      <h3 tabIndex={-1} ref={(element) => queueMicrotask(() => element.focus())}>
        Order sent
      </h3>
      <p>{props.summary}</p>
      <TradingButton tone="primary" onClick={() => props.startNext()}>
        Start creating order
      </TradingButton>
    </div>
  );
}
