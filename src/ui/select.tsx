import { Select } from "@kobalte/core/select";
import { Tooltip } from "@kobalte/core/tooltip";
import { Show, useContext, type JSX } from "solid-js";
import { TradingDialogPopupMount, TradingPopupMount } from "./popup-mount.js";

export interface TradingSelectOption<T> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
  /** Shown under the label, e.g. why an option is unavailable. */
  readonly description?: string;
  /** Optional shorter label and help for a unit menu. */
  readonly menuLabel?: string;
  readonly help?: string;
}

/**
 * Accessible single-choice picker on Kobalte Select. The trigger carries the accessible name; the list renders
 * in the presentation-owned popup surface so docked panels never clip it.
 */
export function TradingSelect<T extends string | number>(props: {
  label: string;
  value: T | undefined;
  options: readonly TradingSelectOption<T>[];
  disabled?: boolean;
  class?: string;
  placeholder?: string;
  unitMenu?: boolean;
  onChange(value: T): void;
  children?: JSX.Element;
}) {
  const popupMount = useContext(TradingPopupMount);
  const dialogMount = useContext(TradingDialogPopupMount);
  const selected = () =>
    props.options.find((option) => option.value === props.value) ?? null;
  return (
    <Select<TradingSelectOption<T>>
      class={`trading-select-root ${props.class ?? ""}`}
      options={props.options as TradingSelectOption<T>[]}
      optionValue={(option) => String(option.value)}
      optionTextValue="label"
      optionDisabled="disabled"
      value={selected()}
      onChange={(option) => {
        if (option && !option.disabled && option.value !== props.value)
          props.onChange(option.value);
      }}
      disabled={props.disabled}
      disallowEmptySelection
      placeholder={props.placeholder}
      placement="bottom-start"
      gutter={4}
      sameWidth
      itemComponent={(item) => (
        <Select.Item item={item.item} class="trading-select-item">
          <span class="trading-select-item-main">
            <Select.ItemLabel>{item.item.rawValue.menuLabel ?? item.item.rawValue.label}</Select.ItemLabel>
            <Show when={item.item.rawValue.help}>{help => (
              <Tooltip placement="right" gutter={6}>
                <Tooltip.Trigger as="span" class="trading-select-info" aria-hidden="true" />
                <Tooltip.Portal mount={dialogMount?.() ?? popupMount}>
                  <Tooltip.Content class="lumen-trading trading-unit-tooltip">{help()}</Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip>
            )}</Show>
          </span>
          <Show when={item.item.rawValue.help}>{help => (
            <Select.ItemDescription class="trading-visually-hidden">{help()}</Select.ItemDescription>
          )}</Show>
          <Show when={item.item.rawValue.description}>
            <Select.ItemDescription class="trading-select-description">
              {item.item.rawValue.description}
            </Select.ItemDescription>
          </Show>
          <Show when={!props.unitMenu}><Select.ItemIndicator class="trading-select-indicator">
            ✓
          </Select.ItemIndicator></Show>
        </Select.Item>
      )}
    >
      <Select.Trigger
        class="trading-select"
        aria-label={props.label}
        data-value={props.value === undefined ? "" : String(props.value)}
      >
        <Select.Value<TradingSelectOption<T>> class="trading-select-value">
          {(state) => state.selectedOption()?.label}
        </Select.Value>
        <Select.Icon class="trading-select-icon">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal mount={dialogMount?.() ?? popupMount}>
        <Select.Content class={`lumen-trading trading-select-content ${props.unitMenu ? "trading-unit-menu" : ""}`}>
          <Select.Listbox class="trading-select-listbox" />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}
