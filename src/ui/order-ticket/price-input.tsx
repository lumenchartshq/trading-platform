import { SwapIcon } from "../icons.js";
import { createUniqueId } from "solid-js";
import type {
  InstrumentInfo,
  Side,
  TradingQuotes,
} from "../../contracts/broker.js";
import {
  relativePriceTicks,
  priceFromTicks,
} from "../../core/relative-price.js";
import { TradingButton } from "../primitives.js";
export function TicketPriceInput(props: {
  relative: boolean;
  toggleRelative(): void;
  kind: "limit" | "stop";
  label: string;
  value?: number;
  instrument: InstrumentInfo;
  side: Side;
  quotes?: Readonly<TradingQuotes>;
  disabled: boolean;
  price(value: number | undefined): string;
  update(value: number | undefined): void;
}) {
  const id = createUniqueId();
  const relative = () => props.relative;
  const name = () => (props.kind === "limit" ? "Limit price" : "Stop price");
  const anchorName = () => (props.side === 1 ? "Ask" : "Bid");
  const anchor = () =>
    props.side === 1 ? props.quotes?.ask : props.quotes?.bid;
  const ticks = () =>
    relativePriceTicks(props.value, anchor(), props.instrument);
  const value = () => (relative() ? ticks() : props.value);
  const paired = () => {
    if (relative()) return props.price(props.value);
    const offset = ticks();
    if (offset === undefined) return `${anchorName()} —`;
    const sign = offset < 0 ? "−" : "+";
    return `${anchorName()} ${sign} ${Math.abs(offset)}`;
  };
  return (
    <div class="trading-field">
      <label for={id}>
        {props.label}
        {relative() ? " (ticks)" : ""}
      </label>
      <div class="trading-paired-input">
        <input
          id={id}
          type="number"
          inputmode="decimal"
          aria-label={name()}
          value={Number.isFinite(value()) ? value() : ""}
          step={
            relative()
              ? "any"
              : ((props.kind === "limit"
                  ? props.instrument.limitPriceStep
                  : props.instrument.stopPriceStep) ?? props.instrument.minTick)
          }
          disabled={props.disabled}
          onInput={(event) => {
            const input = event.currentTarget.value;
            if (input === "") {
              props.update(undefined);
              return;
            }
            const value = Number(input);
            props.update(
              relative()
                ? priceFromTicks(value, anchor(), props.instrument, props.kind)
                : value,
            );
          }}
        />
        <TradingButton
          class="trading-pair-swap"
          aria-label={`Switch ${name().toLowerCase()} between price and ticks`}
          disabled={props.disabled}
          onClick={() => props.toggleRelative()}
        >
          <SwapIcon />
        </TradingButton>
        <span class="trading-paired-value" title={paired()}>
          {paired()}
        </span>
      </div>
    </div>
  );
}
