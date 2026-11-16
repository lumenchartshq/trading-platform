import { useEffectiveMode, type ModeSelection } from "../effective-mode.js";
import { useFinancialLease } from "../financial-lease.js";
import { parseNumberInput } from "../number-input.js";
import { SwapIcon } from "../icons.js";
import { TradingSelect } from "../select.js";
import { batch, createEffect, createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import type {
  InstrumentInfo,
  Side,
} from "../../contracts/broker.js";
import type { TradingSession } from "../../core/session.js";
import {
  isQuantityInputMode,
  quantityInputValue,
  quantityModeAvailable,
  quantityModeSelectable,
  isRiskQuantityMode,
  needsQuantityEquity,
  resolveSizedQuantity,
} from "../../core/quantity-input.js";
import type { QuantityInputMode } from "../../core/quantity-input.js";
import { TradingButton,
  useTradingValue,
  useTradingEntity, useAccountCurrency } from "../primitives.js";

export function TicketQuantityInput(props: {
  active: boolean;
  session: TradingSession;
  symbol: string;
  side: Side;
  stop?: number;
  suggestedStop?: number;
  enableStop?(price: number): void;
  riskAllowed: boolean;
  multipleExits?: boolean;
  label: string;
  qty: number;
  instrument: InstrumentInfo;
  entry?: number;
  disabled: boolean;
  locale?: string;
  update(value: number): void;
  updateSizing(value: number): void;
  onManualQuantityChange(listener: () => void): () => void;
  mode: QuantityInputMode;
  fallbackMode?: QuantityInputMode;
  onModeChange(mode: QuantityInputMode): void;
}) {
  const id = createUniqueId();
  const primary = () => props.mode;
  const setPrimary = (mode: QuantityInputMode) => props.onModeChange(mode);
  onCleanup(() => props.onModeChange("units"));
  const [secondarySelection, setSecondarySelection] = createSignal<ModeSelection<QuantityInputMode>>({ mode: "currency", revision: 0 });
  const secondary = useEffectiveMode(secondarySelection, mode => {
    const paired = mode === "units" && props.fallbackMode ? props.fallbackMode : mode;
    return isRiskQuantityMode(paired) && !props.riskAllowed ? "currency" : paired;
  });
  const setSecondary = (mode: QuantityInputMode) => setSecondarySelection(previous => ({ mode, revision: previous.revision + 1 }));
  const [entered, setEntered] = createSignal<number>();
  const connection = useTradingValue(props.session.state.connection);
  const equity = useTradingValue(props.session.state.equity);
  const accountCurrency = useAccountCurrency(props.session);
  const pipValues = useTradingEntity(
    props.session.state.pipValues,
    () => props.symbol,
  );
  let lastUnits = props.qty;
  let pendingConversion: { mode: QuantityInputMode; qty: number } | undefined;
  onCleanup(
    props.onManualQuantityChange(() => {
      pendingConversion = undefined;
      batch(() => {
        setPrimary("units");
        setEntered(undefined);
        if (secondary() === "units") setSecondary("currency");
      });
    }),
  );
  const context = () => ({
    instrument: props.instrument,
    side: props.side,
    stop: props.stop,
    pipValues: pipValues(),
    riskAllowed: props.riskAllowed,
    price: props.entry,
    equity: equity(),
    accountCurrency: accountCurrency(),
  });
  const modes = (): readonly QuantityInputMode[] => {
    if (props.riskAllowed || props.multipleExits)
      return ["units", "currency", "percentage", "riskMoney", "riskPercentage"];
    return ["units", "currency", "percentage"];
  };
  const modeHelp = (mode: QuantityInputMode) =>
    isRiskQuantityMode(mode) && props.multipleExits
      ? "Risk-based order sizing isn't available when using multiple exit levels"
      : undefined;
  const name = (mode: QuantityInputMode) => {
    if (mode === "units") return props.instrument.units ?? props.label;
    if (mode === "currency") return "Currency";
    if (mode === "riskMoney") return "Risk currency";
    if (mode === "riskPercentage") return "Risk % balance";
    return "% balance";
  };
  const inputName = () => {
    if (primary() === "units") return name("units");
    if (primary() === "currency") return "Quantity in currency";
    if (primary() === "riskMoney") return "Risk amount";
    if (primary() === "riskPercentage") return "Risk percent";
    return "Quantity as percent of equity";
  };
  const selectable = (mode: QuantityInputMode) =>
    quantityModeSelectable(mode, {
      ...context(),
      stop: props.stop ?? props.suggestedStop,
    });
  const available = (mode: QuantityInputMode) =>
    quantityModeAvailable(mode, context());
  const amount = () => (primary() === "units" ? props.qty : entered());
  const paired = (mode: QuantityInputMode) => {
    const value = quantityInputValue(props.qty, mode, context());
    if (value === undefined) return `${name(mode)} unavailable`;
    const text = value.toLocaleString(props.locale ?? "en", {
      maximumFractionDigits: 8,
    });
    if (mode === "units") return `${text} ${props.instrument.units ?? "units"}`;
    if (mode === "currency") return `${text} ${props.instrument.currency}`;
    if (mode === "riskMoney")
      return `${text} ${context().accountCurrency} risk`;
    if (mode === "riskPercentage") return `${text}% risk`;
    return `${text}% balance`;
  };
  function changePrimary(mode: QuantityInputMode): void {
    if (props.disabled || mode === primary() || !selectable(mode)) return;
    const qty =
      Number.isFinite(props.qty) && props.qty > 0 ? props.qty : lastUnits;
    if (Number.isFinite(qty) && qty > 0) lastUnits = qty;
    const stop = props.stop ?? props.suggestedStop;
    const value = quantityInputValue(qty, mode, {
      ...context(),
      stop: isRiskQuantityMode(mode) ? stop : props.stop,
    });
    pendingConversion = value === undefined ? { mode, qty } : undefined;
    const previous = primary(), paired = secondary();
    batch(() => {
      if (
        isRiskQuantityMode(mode) &&
        props.stop === undefined &&
        stop !== undefined
      )
        props.enableStop?.(stop);
      setEntered(value);
      setPrimary(mode);
      if (paired === mode) setSecondary(previous);
    });
    if (mode === "units") props.update(qty);
  }
  const equityDemand = createMemo(
    () =>
      props.active &&
      connection().phase === "ready" &&
      (needsQuantityEquity(primary()) || needsQuantityEquity(secondary())),
  );
  useFinancialLease(props.session, "equity", () => equityDemand() ? "" : undefined);
  const pipDemand = createMemo(() =>
    props.active &&
    connection().phase === "ready" &&
    props.riskAllowed &&
    props.stop !== undefined &&
    (isRiskQuantityMode(primary()) || isRiskQuantityMode(secondary()))
      ? props.symbol
      : undefined,
  );
  useFinancialLease(props.session, "pip", pipDemand);
  // Cash/percentage intent follows entry price/equity changes; units remain canonical.
  createEffect(() => {
    const result = resolveSizedQuantity({
      mode: primary(),
      fallbackMode: props.fallbackMode,
      disabled: !!props.disabled,
      entered: entered(),
      pending: pendingConversion,
      qty: props.qty,
      lastUnits,
      context: context(),
    });
    if (result.clearPending) pendingConversion = undefined;
    if (result.entered !== undefined) setEntered(result.entered);
    if (result.lastUnits !== undefined) lastUnits = result.lastUnits;
    if (result.units !== undefined) props.update(result.units);
    if ("sizing" in result) props.updateSizing(result.sizing!);
  });
  return (
    <div class="trading-field trading-quantity-field">
      <div class="trading-quantity-heading">
        <label for={id} class="trading-visually-hidden">
          {inputName()}
        </label>
        <TradingSelect
          label="Quantity type"
          disabled={props.disabled}
          value={primary()}
          options={modes().map((mode) => ({
            value: mode,
            label: name(mode),
            disabled: !selectable(mode),
            description: selectable(mode) ? undefined : modeHelp(mode),
          }))}
          onChange={(mode) => {
            if (isQuantityInputMode(mode)) changePrimary(mode);
          }}
        />
      </div>
      <div class="trading-paired-input">
        <input
          data-ui="order-quantity-input"
          id={id}
          type="number"
          inputmode="decimal"
          aria-label={inputName()}
          value={Number.isFinite(amount()) ? amount() : ""}
          min={primary() === "units" ? props.instrument.qty.min : 0}
          max={primary() === "units" ? props.instrument.qty.max : undefined}
          step={
            primary() === "units"
              ? (props.instrument.qty.uiStep ?? props.instrument.qty.step)
              : "any"
          }
          disabled={props.disabled || !available(primary())}
          onInput={(event) => {
            const value =
              parseNumberInput(event.currentTarget.value) ?? NaN;
            if (primary() === "units") {
              if (Number.isFinite(value) && value > 0) lastUnits = value;
              props.update(value);
            } else setEntered(value);
          }}
        />
        <TradingButton
          class="trading-pair-swap"
          aria-label="Swap quantity display"
          disabled={props.disabled || !available(secondary())}
          onClick={() => changePrimary(secondary())}
        >
          <SwapIcon />
        </TradingButton>
        <TradingSelect
          class="trading-paired-value trading-quantity-secondary"
          label="Paired quantity display"
          value={secondary()}
          disabled={props.disabled}
          options={modes()
            .filter((mode) => mode !== primary())
            .map((mode) => ({
              value: mode,
              label: paired(mode),
              disabled: !selectable(mode),
              description: selectable(mode) ? undefined : modeHelp(mode),
            }))}
          onChange={(mode) => {
            if (isQuantityInputMode(mode) && mode !== primary())
              setSecondary(mode);
          }}
        />
      </div>
      <Show
        when={
          primary() !== "units" &&
          (!available(primary()) || !Number.isFinite(props.qty))
        }
      >
        <p role="status" class="trading-field-help">
          A valid amount, price and currency value are needed to calculate
          quantity.
        </p>
      </Show>
    </div>
  );
}
