import { Show } from "solid-js";
import { Side } from "../../contracts/broker.js";
import { TradingButton } from "../primitives.js";
export function SubmitBar(props: {
  modifying: boolean; hidden: boolean; busy: boolean; unavailable: boolean; untradable: boolean;
  hasBrokerOrder: boolean; side: Side; action: string; summary: string; discard(): void;
}) {
  const sideName = () => props.side === Side.Buy ? "Buy" : "Sell";
  return (
    <Show
      when={props.modifying}
      fallback={
        <div hidden={props.hidden} class="trading-ticket-submit">
          <TradingButton
            type="submit"
            class="trading-trade-button"
            tone={props.side === Side.Buy ? "buy" : "sell"}
            aria-label={props.action}
            disabled={props.busy || props.unavailable || !!props.untradable}
          >
            <strong>{sideName()}</strong>
            <span>{props.summary}</span>
          </TradingButton>
        </div>
      }
    >
      <div
        hidden={props.hidden}
        class="trading-ticket-submit trading-modify-actions"
      >
        <TradingButton
          type="submit"
          tone="primary"
          aria-label={props.action}
          disabled={props.busy || props.unavailable || !props.hasBrokerOrder}
        >
          Confirm
        </TradingButton>
        <TradingButton onClick={() => props.discard()}>
          Discard
        </TradingButton>
      </div>
    </Show>
  );
}
