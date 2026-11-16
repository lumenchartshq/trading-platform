import { Show } from "solid-js";
import type { Tradability } from "../../core/tradability.js";
import { TradingButton } from "../primitives.js";
export function UntradableNotice(props: {
  value: Tradability; canChangeSymbol: boolean; error?: string; label: string; solve(): void;
}) {
  return (
    <div role="alert" class="trading-untradable" data-ui="untradable">
      <strong>{props.value.heading ?? "This symbol can't be traded"}</strong>
      <Show when={props.value.reason}>
        <p>{props.value.reason}</p>
      </Show>
      <Show
        when={
          props.value.solution?.kind !== "symbol" || props.canChangeSymbol
        }
      >
        <TradingButton onClick={() => props.solve()}>
          {props.label}
        </TradingButton>
      </Show>
      <Show when={props.error}>
        <p class="trading-error">{props.error}</p>
      </Show>
    </div>
  );
}
