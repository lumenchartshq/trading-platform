import { Side } from "../../contracts/broker.js";
import type { PreOrder } from "../../contracts/broker.js";
import type { TradingChartBinding } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { TradingButton } from "../primitives.js";
import { useTicketMarket } from "../order-ticket/market.js";
import type { QuoteWidths } from "./quote-widths.js";
import { animationFrames, type FrameScheduler } from "../../chart/frame-batch.js";

/** Mount only while visible: the quote lease belongs to these controls. */
export function ChartQuoteButtons(props: {
  session: TradingSession;
  binding: TradingChartBinding;
  disabled: boolean;
  widths: QuoteWidths;
  open(binding: TradingChartBinding, template: Partial<PreOrder>, initiator?: HTMLElement): void;
  /** Quote prices repaint once per frame however many quotes arrive; browser frames by default. */
  frames?: FrameScheduler;
}) {
  const market = useTicketMarket(props.session, () => props.binding.symbol, () => true, props.frames ?? animationFrames());
  const price = (side: Side) => market.price(side === Side.Buy ? market.ready()?.ask : market.ready()?.bid);
  const open = (event: MouseEvent & { currentTarget: HTMLButtonElement }, side: Side) => {
    event.currentTarget.focus();
    props.open(props.binding, { side }, event.currentTarget);
  };
  return (
    <div class="trading-chart-quotes">
      <TradingButton
        class="trading-chart-quote"
        ref={(element) => props.widths.observe("sell", element)}
        style={{ "min-width": props.widths.minimum("sell") }}
        tone="sell"
        disabled={props.disabled}
        aria-label={`Sell ${price(Side.Sell)}`}
        onClick={(event) => open(event, Side.Sell)}
      >
        <span>{price(Side.Sell)}</span>
        <small>Sell</small>
      </TradingButton>
      <span
        class="trading-chart-spread"
        ref={(element) => props.widths.observe("spread", element)}
        style={{ "min-width": props.widths.minimum("spread") }}
      >
        <span class="trading-visually-hidden">Spread </span>
        {market.spread()}
      </span>
      <TradingButton
        class="trading-chart-quote"
        ref={(element) => props.widths.observe("buy", element)}
        style={{ "min-width": props.widths.minimum("buy") }}
        tone="buy"
        disabled={props.disabled}
        aria-label={`Buy ${price(Side.Buy)}`}
        onClick={(event) => open(event, Side.Buy)}
      >
        <span>{price(Side.Buy)}</span>
        <small>Buy</small>
      </TradingButton>
    </div>
  );
}
