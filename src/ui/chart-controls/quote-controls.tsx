import { Show } from "solid-js";
import type { PreOrder } from "../../contracts/broker.js";
import type { TradingChartBinding, ReadonlyValue, TradingChartPort } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { useWatchedValue, useTradingValue, TradingButton } from "../primitives.js";
import { useChartQuoteEligibility } from "./eligibility.js";
import { ChartQuoteButtons } from "./quote-buttons.js";
import { useQuoteWidths } from "./quote-widths.js";
export function QuoteControls(props: {
  visible?: ReadonlyValue<boolean>;
  session: TradingSession;
  chart: TradingChartPort;
  open(
    binding: TradingChartBinding,
    template: Partial<PreOrder>,
    initiator?: HTMLElement,
  ): void;
  depth(): void;
}) {
  const binding = useTradingValue(props.chart.binding),
    connection = useTradingValue(props.session.state.connection),
    policy = useTradingValue(props.session.policy);
  const widths = useQuoteWidths(() => binding().symbol);
  const eligible = useChartQuoteEligibility(
    props.session,
    props.chart,
    props.visible,
  );
  const visibility = props.session.host.sellBuyButtonsVisibility();
  const visible = visibility ? useWatchedValue(visibility) : () => true;
  return (
    <div data-ui="trading-chart-controls">
      <Show when={props.session.features.buy_sell_buttons && eligible.shortReason()}>
        {(reason) => (
          <span class="trading-short-reason" role="status">
            {reason()}
          </span>
        )}
      </Show>
      <Show
        when={
          props.session.features.buy_sell_buttons && visible() && eligible()
        }
      >
        <ChartQuoteButtons
          widths={widths}
          session={props.session}
          binding={binding()}
          disabled={connection().phase !== "ready"}
          open={props.open}
        />
      </Show>
      <Show when={props.session.features.dom_widget && !props.session.features.trading_account_manager}>
        <TradingButton disabled={connection().phase !== "ready" || !policy().dom} onClick={props.depth}>
          Market depth
        </TradingButton>
      </Show>
    </div>
  );
}
