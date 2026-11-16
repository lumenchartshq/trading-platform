import { useEffectiveMode, type ModeSelection } from "../effective-mode.js";
import { effectiveExitMode } from "./mode-rules.js";
import { useFinancialLease } from "../financial-lease.js";
import { parseNumberInput } from "../number-input.js";
import { Tooltip } from "@kobalte/core/tooltip";
import { useContext } from "solid-js";
import { TradingDialogPopupMount, TradingPopupMount } from "../popup-mount.js";
import { protectionDirectionError } from "../../core/protection-rules.js";
import { SwapIcon } from "../icons.js";
import { TradingSwitch } from "../switch.js";
import { TradingSelect } from "../select.js";
import { batch, createSignal, createUniqueId, createMemo, Show } from "solid-js";
import type { JSX } from "solid-js";
import type {
  InstrumentInfo,
  Side,
} from "../../contracts/broker.js";
import {
  bracketInputPrice,
  bracketInputValue,
  bracketInputUnits,
  isBracketInputUnit, defaultBracketPrice } from "../../core/bracket-input.js";
import type { BracketInputUnit } from "../../core/bracket-input.js";
import { TradingButton,
  useTradingValue,
  useTradingEntity, useAccountCurrency } from "../primitives.js";
import type { TradingSession } from "../../core/session.js";
import {
  monetaryPointValue,
  sidePipValue,
} from "../../core/financial-rules.js";
export function ExitInput(props: {
  active: boolean;
  session: TradingSession;
  quantity: number;
  symbol: string;
  label: string;
  value?: number;
  entry?: number;
  /** Price the exit must sit around; defaults to `entry`. Positions measure from the current price. */
  directionReference?: { readonly price: number | undefined; readonly name: string };
  side: Side;
  profit: boolean;
  instrument: InstrumentInfo;
  disabled: boolean;
  toggleDisabled?: boolean;
  allowDistance: boolean;
  allowMoney: boolean;
  inInstrumentCurrency: boolean;
  /** Replaces the label text in the heading, e.g. a stop type menu; unit names then drop the label prefix. */
  labelControl?: JSX.Element;
  /** Unit shown first; trailing stops start in distance. */
  defaultUnit?: BracketInputUnit;
  /** False for fields stored as a distance, so converted prices keep fractional pips. */
  snapPrices?: boolean;
  price(value: number | undefined): string;
  update(value: number | undefined): void;
}) {
  const id = createUniqueId();
  const popupMount = useContext(TradingPopupMount);
  const dialogMount = useContext(TradingDialogPopupMount);
  const connection = useTradingValue(props.session.state.connection);
  const equity = useTradingValue(props.session.state.equity);
  const accountCurrency = useAccountCurrency(props.session);
  const currency = () =>
    props.inInstrumentCurrency ? props.instrument.currency : accountCurrency();
  const pipValues = useTradingEntity(
    props.session.state.pipValues,
    () => props.symbol,
  );
  const [unitSelection, setUnitSelection] = createSignal<ModeSelection<BracketInputUnit>>({ mode: props.defaultUnit ?? "price", revision: 0 });
  const unit = useEffectiveMode(unitSelection, mode => effectiveExitMode(mode, props.allowMoney));
  const setUnit = (mode: BracketInputUnit) => setUnitSelection(previous => ({ mode, revision: previous.revision + 1 }));
  const [secondarySelection, setSecondarySelection] = createSignal<ModeSelection<BracketInputUnit>>({ mode: "distance", revision: 0 });
  const setSecondary = (mode: BracketInputUnit) => setSecondarySelection(previous => ({ mode, revision: previous.revision + 1 }));
  let remembered: number | undefined;
  const pipValue = () =>
    sidePipValue(props.side, props.instrument, pipValues());
  const pointValue = (account = false) =>
    monetaryPointValue({
      instrument: props.instrument,
      pipValue: pipValue(),
      currency:
        !account && props.inInstrumentCurrency ? "instrument" : "account",
      accountCurrency: accountCurrency(),
    });
  const hasQuantity = () =>
    props.quantity > 0 && Number.isFinite(props.quantity);
  const moneyBase = () =>
    props.allowMoney && props.instrument.pipValue !== 0 && hasQuantity();
  const moneyAvailable = () => moneyBase() && !!currency() && !!pointValue();
  const equitySelectable = () =>
    moneyBase() && !!accountCurrency() && !!pointValue(true);
  const equityAvailable = () =>
    equitySelectable() &&
    equity() !== undefined &&
    Number.isFinite(equity()) &&
    equity()! > 0;
  const enabled = () => props.value !== undefined;
  const directionError = () => props.snapPrices === false ? undefined : protectionDirectionError(
    props.profit ? { takeProfit: props.value } : { stopLoss: props.value },
    props.side,
    props.directionReference ? props.directionReference.price : props.entry,
    props.directionReference?.name,
  );
  function selectable(mode: BracketInputUnit): boolean {
    if (mode === "price") return true;
    if (mode === "distance") return props.allowDistance;
    if (mode === "percentage")
      return (
        props.entry !== undefined &&
        Number.isFinite(props.entry) &&
        props.entry !== 0
      );
    if (mode === "money") return moneyAvailable();
    return equitySelectable();
  }
  const activeUnit = () => {
    if (unit() === "distance" && !props.allowDistance) return "price";
    if (
      (unit() === "money" || unit() === "equityPercentage") &&
      !props.allowMoney
    )
      return "price";
    return unit();
  };
  function changeUnit(next: BracketInputUnit): void {
    if (!selectable(next) || next === unit()) return;
    const previous = activeUnit(), paired = secondary();
    batch(() => {
      setUnit(next);
      if (paired === next) setSecondary(previous);
    });
  }
  const supported = (mode: BracketInputUnit) => {
    if (mode === "distance") return props.allowDistance;
    if (mode === "money" || mode === "equityPercentage")
      return props.allowMoney;
    return true;
  };
  const secondary = useEffectiveMode(secondarySelection, mode => {
    if (mode !== activeUnit() && supported(mode)) return mode;
    return bracketInputUnits.find(candidate => candidate !== activeUnit() && selectable(candidate)) ?? "price";
  });
  const displayed = (mode: BracketInputUnit) =>
    activeUnit() === mode || secondary() === mode;
  const financialActive = () =>
    props.active &&
    enabled() &&
    !props.disabled &&
    connection().phase === "ready";
  const equityDemand = createMemo(
    () =>
      financialActive() && props.allowMoney && displayed("equityPercentage"),
  );
  useFinancialLease(props.session, "equity", () => equityDemand() ? "" : undefined);
  const pipDemand = createMemo(() => {
    if (!financialActive() || !props.allowMoney) return undefined;
    const accountMoney =
      !props.inInstrumentCurrency ||
      props.instrument.currency === accountCurrency();
    return displayed("equityPercentage") || (displayed("money") && accountMoney)
      ? props.symbol
      : undefined;
  });
  useFinancialLease(props.session, "pip", pipDemand);
  const context = () => ({
    entry: props.entry,
    side: props.side,
    profit: props.profit,
    instrument: props.instrument,
    quantity: props.quantity,
    pipValue: pipValue(),
    moneyCurrency: props.inInstrumentCurrency
      ? ("instrument" as const)
      : ("account" as const),
    accountCurrency: accountCurrency(),
    equity: equity(),
  });
  // Fixed exits start around their validation reference; a trailing distance is converted around entry.
  const defaultPrice = () =>
    defaultBracketPrice(props.profit, {
      ...context(),
      entry: props.snapPrices === false ? props.entry : (props.directionReference?.price ?? props.entry),
    }, props.snapPrices ?? true);
  const canonicalPrice = () => (enabled() ? props.value : defaultPrice());
  const value = () =>
    bracketInputValue(canonicalPrice(), activeUnit(), context());
  const distanceName = () =>
    props.instrument.pipSize &&
    props.instrument.pipSize !== props.instrument.minTick
      ? "pips"
      : "ticks";
  const modeName = (mode: BracketInputUnit) => {
    if (mode === "price") return "price";
    if (mode === "distance") return distanceName();
    if (mode === "percentage") return "% price";
    if (mode === "money") return currency() ?? "money";
    return "% balance";
  };
  const unitMenuLabel = (mode: BracketInputUnit) => {
    if (mode === "price") return "Price";
    if (mode === "distance") return distanceName() === "pips" ? "Pips" : "Ticks";
    if (mode === "percentage") return "% price";
    if (mode === "money") return props.profit ? "Reward money" : "Risk money";
    return props.profit ? "Reward % balance" : "Risk % balance";
  };
  const unitHelp = (mode: BracketInputUnit) => {
    if (mode === "price") return undefined;
    if (mode === "distance") return `Exit price is equal to the number of ${distanceName()} from the main order price`;
    if (mode === "percentage") return "Exit price is calculated as a percentage of the main order price";
    const action = props.profit ? "gain if the take profit" : "lose if the stop loss";
    return mode === "money" ? `Cash amount you will ${action} is executed` : `Percentage of equity you will ${action} is executed`;
  };
  const paired = (mode: BracketInputUnit) => {
    if (mode === "price") return props.price(canonicalPrice());
    const amount = bracketInputValue(canonicalPrice(), mode, context());
    return amount === undefined
      ? `${modeName(mode)} unavailable`
      : `${amount} ${modeName(mode)}`;
  };
  const inputUnavailable = () =>
    (activeUnit() === "money" && !moneyAvailable()) ||
    (activeUnit() === "equityPercentage" && !equityAvailable());
  const unavailableText = () => {
    const value = equity();
    if (value === undefined || !Number.isFinite(value) || value <= 0)
      return "Account equity is unavailable.";
    return "Money value is unavailable.";
  };
  return (
    <div class="trading-exit-field">
      <div class="trading-exit-heading">
        <label for={id} class="trading-visually-hidden">
          {props.label}
        </label>
        <div class="trading-exit-labels">
          {props.labelControl}
          <TradingSelect
            class="trading-exit-units"
            unitMenu
            label={`${props.label} units`}
            value={activeUnit()}
            disabled={props.disabled}
            options={bracketInputUnits.map((mode) => ({
              value: mode,
              label: props.labelControl
                ? modeName(mode)
                : `${props.label} ${modeName(mode)}`,
              menuLabel: unitMenuLabel(mode),
              help: unitHelp(mode),
              disabled: !selectable(mode),
            }))}
            onChange={(mode) => {
              if (isBracketInputUnit(mode)) changeUnit(mode);
            }}
          />
        </div>
        <TradingSwitch
          label={`Enable ${props.label.toLowerCase()}`}
          checked={enabled()}
          disabled={props.disabled || props.toggleDisabled}
          onChange={(checked) => {
            if (!checked) {
              remembered = props.value;
              props.update(undefined);
              return;
            }
            props.update(remembered ?? defaultPrice() ?? NaN);
          }}
        />
      </div>
      <Show when={directionError()}>{message => <span id={`${id}-error`} class="trading-visually-hidden">{message()}</span>}</Show>
      <Tooltip disabled={!directionError()} placement="top" gutter={6} openDelay={0}>
      <Tooltip.Trigger as="div"
        class="trading-paired-input"
        data-invalid={!!directionError()}
        data-disabled={!enabled() || props.disabled || inputUnavailable()}
      >
        <input
          id={id}
          type="number"
          inputmode="decimal"
          aria-label={props.label}
          aria-invalid={!!directionError()}
          aria-describedby={directionError() ? `${id}-error` : undefined}
          value={Number.isFinite(value()) ? value() : ""}
          step={activeUnit() === "price" ? props.instrument.minTick : "any"}
          disabled={!enabled() || props.disabled || inputUnavailable()}
          onInput={(event) =>
            props.update(
              bracketInputPrice(
                parseNumberInput(event.currentTarget.value) ?? NaN,
                activeUnit(),
                context(),
                props.snapPrices ?? true,
              ),
            )
          }
        />
        <TradingButton
          class="trading-pair-swap"
          aria-label={`Switch ${props.label.toLowerCase()} units`}
          disabled={
            props.disabled ||
            secondary() === activeUnit() ||
            !selectable(secondary())
          }
          onClick={() => changeUnit(secondary())}
        >
          <SwapIcon />
        </TradingButton>
        <TradingSelect
          class="trading-paired-value trading-quantity-secondary"
          label={`Paired ${props.label.toLowerCase()} display`}
          value={secondary()}
          disabled={props.disabled || secondary() === activeUnit()}
          options={bracketInputUnits
            .filter(
              (mode) => mode !== activeUnit() || secondary() === activeUnit(),
            )
            .map((mode) => ({
              value: mode,
              label: paired(mode),
              disabled: !selectable(mode),
            }))}
          onChange={(mode) => {
            if (
              isBracketInputUnit(mode) &&
              mode !== activeUnit() &&
              selectable(mode)
            )
              setSecondary(mode);
          }}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal mount={dialogMount?.() ?? popupMount}>
        <Tooltip.Content class="lumen-trading trading-validation-tooltip">{directionError()}</Tooltip.Content>
      </Tooltip.Portal>
      </Tooltip>
      <Show
        when={
          enabled() && activeUnit() === "equityPercentage" && !equityAvailable()
        }
      >
        <p role="status" class="trading-field-help">
          {unavailableText()}
        </p>
      </Show>
    </div>
  );
}
