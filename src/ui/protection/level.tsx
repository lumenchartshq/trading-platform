import { formatPercent } from "../../core/number-precision.js";
import { parseNumberInput } from "../number-input.js";
import { TradingSelect } from "../select.js";
import { createSignal, Show, For } from "solid-js";
import type { ExitLevel } from "../../contracts/broker.js";
import { TradingButton } from "../primitives.js";
import { ProtectionFields, type ProtectionFieldsProps } from "./fields.js";

type Fields = Omit<ProtectionFieldsProps, "quantity" | "brackets" | "update">;
export function ExitLevelEditor(
  props: Fields & {
    level: Readonly<ExitLevel>;
    index: number;
    parentQuantity: number;
    workspace: boolean;
    expanded: boolean;
    toggle(): void;
    remove(): void;
    update(value: Partial<ExitLevel>): void;
  },
) {
  const [percentage, setPercentage] = createSignal(false);
  const allocation = () =>
    props.parentQuantity > 0
      ? (props.level.qty / props.parentQuantity) * 100
      : undefined;
  const value = () => (percentage() ? allocation() : props.level.qty);
  /** Reference summary: colour-coded leg labels, `TP 3 @ 340.34 • SL 3 @ 341.34`. */
  const legs = () => {
    const level = props.level;
    const parts: { kind: "tp" | "sl"; label: string; text: string }[] = [];
    if (level.takeProfit !== undefined)
      parts.push({ kind: "tp", label: "TP", text: `${level.qty} @ ${props.price(level.takeProfit)}` });
    if (level.stopLoss !== undefined)
      parts.push({ kind: "sl", label: "SL", text: `${level.qty} @ ${props.price(level.stopLoss)}` });
    if (level.guaranteedStop !== undefined)
      parts.push({ kind: "sl", label: "Guaranteed", text: `${level.qty} @ ${props.price(level.guaranteedStop)}` });
    if (level.trailingStopPips !== undefined)
      parts.push({ kind: "sl", label: "Trailing", text: `${level.qty} · ${level.trailingStopPips}` });
    return parts;
  };
  const percent = formatPercent;
  return (
    <section
      class="trading-exit-level"
      data-exit-level={props.level.id}
      data-expanded={props.expanded}
    >
      <header class="trading-exit-level-heading">
        <TradingButton
          class="trading-exit-level-toggle"
          aria-expanded={props.expanded}
          onClick={props.toggle}
          disabled={!props.workspace}
        >
          Level {props.index + 1} · {percent(allocation())}
        </TradingButton>
        <TradingButton
          class="trading-icon-button"
          aria-label="Remove level"
          disabled={props.disabled}
          onClick={props.remove}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v6M13.5 10.5v6" />
          </svg>
        </TradingButton>
      </header>
      <Show when={props.workspace && !props.expanded}>
        <TradingButton
          class="trading-exit-level-summary"
          onClick={props.toggle}
        >
          <For each={legs()}>
            {(leg, index) => (
              <>
                <Show when={index() > 0}>{" • "}</Show>
                <span class={`trading-leg trading-leg-${leg.kind}`}>{leg.label}</span>{" "}
                {leg.text}
              </>
            )}
          </For>
        </TradingButton>
      </Show>
      <div class="trading-exit-level-fields" hidden={!props.expanded}>
        <div class="trading-field">
          <div class="trading-exit-quantity-label">
            <TradingSelect
              label="Exit quantity type"
              value={percentage() ? "percentage" : "units"}
              disabled={props.disabled}
              options={[
                { value: "units", label: props.instrument.units ?? "Units" },
                { value: "percentage", label: "% of order" },
              ]}
              onChange={(value) => setPercentage(value === "percentage")}
            />
          </div>
          <div class="trading-paired-input">
            <input
              type="number"
              inputmode="decimal"
              aria-label={
                percentage() ? "Exit allocation percent" : "Exit quantity"
              }
              value={Number.isFinite(value()) ? value() : ""}
              min={percentage() ? 0 : props.instrument.qty.min}
              max={percentage() ? 100 : props.parentQuantity}
              step={percentage() ? "any" : props.instrument.qty.step}
              disabled={props.disabled}
              onInput={(event) => {
                const next =
                  parseNumberInput(event.currentTarget.value) ?? NaN;
                props.update({
                  qty: percentage()
                    ? (next / 100) * props.parentQuantity
                    : next,
                });
              }}
            />
            <TradingButton
              class="trading-pair-swap"
              aria-label="Swap exit quantity display"
              disabled={props.disabled}
              onClick={() => setPercentage((value) => !value)}
            >
              ⇄
            </TradingButton>
            <span class="trading-paired-value">
              {percentage()
                ? `${props.level.qty} ${props.instrument.units ?? "units"}`
                : percent(allocation())}
            </span>
          </div>
        </div>
        <ProtectionFields
          {...props}
          brackets={props.level}
          quantity={props.level.qty}
          reportedTrailingPrice={undefined}
          stopMoneyAllowed={true}
          update={(value) => {
            const { stopType: _stopType, ...brackets } = value;
            props.update(brackets);
          }}
        />
      </div>
    </section>
  );
}
