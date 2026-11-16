import { createSignal, Show } from "solid-js";
import type { TradingDialogRequest } from "../../core/dialog-coordinator.js";
import { validateQuantity } from "../../core/trading-rules.js";
import { NumberField, TradingButton } from "../primitives.js";

export function CloseAmountForm(props: {
  request: Extract<TradingDialogRequest, { kind: "closeAmount" }>;
  approve(amount: number): void;
  cancel(): void;
}) {
  const [amount, setAmount] = createSignal<number | undefined>(
    props.request.position.qty,
  );
  const [error, setError] = createSignal<string>();
  const exactNativeClose = () =>
    props.request.nativeFullClose && amount() === props.request.position.qty;
  function submit(): void {
    try {
      const value = amount() ?? NaN;
      if (!exactNativeClose()) validateQuantity(value, props.request.instrument.qty);
      if (value > props.request.position.qty) {
        setError("Choose a quantity within this position.");
        return;
      }
      props.approve(value);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Enter a valid close quantity.",
      );
    }
  }
  return (
    <form
      noValidate={exactNativeClose()}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p class="trading-dialog-lines">
        <span>{props.request.position.symbol}</span>
        <span>Open quantity {props.request.position.qty}</span>
      </p>
      <NumberField
        label="Close quantity"
        value={amount()}
        min={props.request.instrument.qty.min}
        max={props.request.position.qty}
        step={
          props.request.instrument.qty.uiStep ??
          props.request.instrument.qty.step
        }
        onChange={setAmount}
      />
      <Show when={props.request.cancelsBrackets}>
        <p class="trading-muted">
          Its take-profit and stop-loss orders will also be cancelled.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="trading-error">
          {error()}
        </p>
      </Show>
      <div class="trading-actions">
        <TradingButton onClick={props.cancel}>Keep position</TradingButton>
        <TradingButton type="submit" tone="primary">
          {props.request.preview ? "Review close" : "Close position"}
        </TradingButton>
      </div>
    </form>
  );
}
