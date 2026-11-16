import { parseNumberInput } from "../number-input.js";
import { TradingSwitch } from "../switch.js";
import { TradingSelect } from "../select.js";
import { createMemo, createSignal, createUniqueId, Match, Show, Switch } from "solid-js";
import type { ComponentProps } from "solid-js";
import { StopType } from "../../contracts/broker.js";
import type { Brackets } from "../../contracts/broker.js";
import type { CapabilityPolicy } from "../../core/capabilities.js";
import { bracketInputValue, bracketStopType, hasStop, defaultBracketPrice, defaultExitDistance } from "../../core/bracket-input.js";
import { ExitInput } from "./exit-input.js";

type PriceInputProps = Omit<
  ComponentProps<typeof ExitInput>,
  "value" | "label" | "profit" | "update"
>;
const styles = [
  StopType.StopLoss,
  StopType.TrailingStop,
  StopType.GuaranteedStop,
] as const;
function styleName(type: StopType): string {
  if (type === StopType.TrailingStop) return "Trailing stop";
  if (type === StopType.GuaranteedStop) return "Guaranteed stop";
  return "Stop loss";
}
/** Stop styles are exclusive broker fields. Quotes never advance the reported trailing price. */
export function StopProtectionInput(
  props: PriceInputProps & {
    order: Readonly<Brackets>;
    policy: CapabilityPolicy;
    modifying: boolean;
    reportedTrailingPrice?: number;
    updateProtection(value: Brackets & { stopType: StopType }): void;
  },
) {
  const id = createUniqueId();
  const supported = (type: StopType) => {
    if (type === StopType.TrailingStop)
      return props.policy.flags.supportTrailingStop;
    if (type === StopType.GuaranteedStop)
      return props.policy.flags.supportGuaranteedStop;
    return props.policy.flags.supportStopLoss;
  };
  const [selected, select] = createSignal<StopType>();
  const type = createMemo(() => {
    const current = bracketStopType(props.order);
    if (current !== undefined) return current;
    const choice = selected();
    if (choice !== undefined && supported(choice)) return choice;
    return styles.find(supported) ?? StopType.StopLoss;
  });
  const enabled = () => hasStop(props.order);
  const trailingLocked = () =>
    props.modifying && !props.policy.flags.supportModifyTrailingStop;
  const disabled = () =>
    props.disabled ||
    !supported(type()) ||
    (type() === StopType.TrailingStop && trailingLocked());
  const defaultPrice = () =>
    defaultBracketPrice(false, {
      entry: props.directionReference?.price ?? props.entry,
      side: props.side,
      instrument: props.instrument,
    });
  // The broker field is a distance in pips; the shared exit input edits it as a protective price
  // so price, %, money and balance units work like any stop. Without an entry only pips are editable.
  const distanceContext = () => ({
    entry: props.entry,
    side: props.side,
    profit: false,
    instrument: props.instrument,
  });
  const trailingAsPrice = () =>
    props.entry !== undefined && Number.isFinite(props.entry);
  // Not tick-snapped: a fractional pip distance must survive the round trip unchanged.
  const trailingPrice = () => {
    const distance = props.order.trailingStopPips;
    const pip = props.instrument.pipSize ?? props.instrument.minTick;
    if (distance === undefined) return undefined;
    if (!Number.isFinite(distance) || !(pip > 0)) return NaN;
    return props.entry! - distance * pip * props.side;
  };
  function updateTrailingPrice(price: number | undefined): void {
    if (price === undefined) {
      rememberedDistance = props.order.trailingStopPips;
      update(StopType.TrailingStop, undefined);
      return;
    }
    const distance = Number.isFinite(price)
      ? (bracketInputValue(price, "distance", distanceContext()) ?? NaN)
      : NaN;
    rememberedDistance = distance;
    update(StopType.TrailingStop, distance);
  }
  let rememberedDistance: number | undefined;
  function update(type: StopType, value: number | undefined): void {
    select(type);
    props.updateProtection({
      stopLoss: type === StopType.StopLoss ? value : undefined,
      guaranteedStop: type === StopType.GuaranteedStop ? value : undefined,
      trailingStopPips: type === StopType.TrailingStop ? value : undefined,
      stopType: type,
    });
  }
  function changeStyle(next: StopType): void {
    if (
      props.disabled ||
      next === type() ||
      !supported(next) ||
      (trailingLocked() &&
        (next === StopType.TrailingStop || type() === StopType.TrailingStop))
    )
      return;
    if (props.order.trailingStopPips !== undefined)
      rememberedDistance = props.order.trailingStopPips;
    const active = enabled();
    const price = props.order.stopLoss ?? props.order.guaranteedStop;
    select(next);
    if (!active) return;
    update(
      next,
      next === StopType.TrailingStop
        ? (rememberedDistance ?? defaultExitDistance(false))
        : (price ?? defaultPrice() ?? NaN),
    );
  }
  const choosable = () =>
    styles.filter(supported).length > 1 || !supported(type());
  // The stop's own label picks its style, as in the reference order panel.
  const typeMenu = () => (
    <TradingSelect
      class="trading-exit-type"
      label="Stop type"
      value={type()}
      disabled={
        props.disabled ||
        (type() === StopType.TrailingStop && trailingLocked())
      }
      options={styles
        .filter((style) => supported(style) || style === type())
        .map((style) => ({
          value: style,
          label: styleName(style),
          disabled:
            !supported(style) ||
            (style === StopType.TrailingStop && trailingLocked()),
        }))}
      onChange={changeStyle}
    />
  );
  // Trailing stops edit as a price when an entry exists; otherwise only the pips distance is editable.
  const layout = createMemo((): "price" | "trailing" | "trailingPips" => {
    if (type() !== StopType.TrailingStop) return "price";
    if (trailingAsPrice()) return "trailing";
    return "trailingPips";
  });
  return (
    <div class="trading-stop-protection">
      <Switch>
        <Match when={layout() === "price"}>
          <ExitInput
            {...props}
            label={styleName(type())}
            labelControl={choosable() ? typeMenu() : undefined}
            profit={false}
            disabled={disabled()}
            value={
              type() === StopType.GuaranteedStop
                ? props.order.guaranteedStop
                : props.order.stopLoss
            }
            update={(value) => update(type(), value)}
          />
        </Match>
        <Match when={layout() === "trailing"}>
          <ExitInput
            {...props}
            label={styleName(StopType.TrailingStop)}
            labelControl={choosable() ? typeMenu() : undefined}
            defaultUnit="distance"
            snapPrices={false}
            profit={false}
            disabled={disabled()}
            value={trailingPrice()}
            update={updateTrailingPrice}
          />
        </Match>
        <Match when={layout() === "trailingPips"}>
          <div class="trading-exit-field">
            <div class="trading-exit-heading">
              <Show
                when={choosable()}
                fallback={<label for={id}>Trailing stop distance</label>}
              >
                <div class="trading-exit-labels">
                  {typeMenu()}
                  <label for={id} class="trading-muted">
                    distance
                  </label>
                </div>
              </Show>
              <TradingSwitch
                label="Enable trailing stop"
                checked={props.order.trailingStopPips !== undefined}
                disabled={disabled() || props.toggleDisabled}
                onChange={(checked) => {
                  if (!checked) {
                    rememberedDistance = props.order.trailingStopPips;
                    update(StopType.TrailingStop, undefined);
                    return;
                  }
                  update(StopType.TrailingStop, rememberedDistance ?? defaultExitDistance(false));
                }}
              />
            </div>
            <div
              class="trading-paired-input"
              data-disabled={disabled() || !enabled()}
            >
              <input
                id={id}
                type="number"
                inputmode="decimal"
                aria-label="Trailing stop distance"
                step="any"
                min="0"
                value={
                  Number.isFinite(props.order.trailingStopPips)
                    ? props.order.trailingStopPips
                    : ""
                }
                disabled={disabled() || !enabled()}
                onInput={(event) => {
                  const value =
                    parseNumberInput(event.currentTarget.value) ?? NaN;
                  rememberedDistance = value;
                  update(StopType.TrailingStop, value);
                }}
              />
              <span>pips</span>
            </div>
          </div>
        </Match>
      </Switch>
      <Show
        when={
          type() === StopType.TrailingStop &&
          props.reportedTrailingPrice !== undefined
        }
      >
        <p class="trading-muted">
          Current stop price: {props.price(props.reportedTrailingPrice)}
        </p>
      </Show>
    </div>
  );
}
