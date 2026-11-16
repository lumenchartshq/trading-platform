import { For, Show, createSignal, createUniqueId, onCleanup } from "solid-js";
import type { TradingSettingsField, TradingSettingsValue } from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import {
  applyTradingSettings,
  subscribeTradingSettings,
  tradingSettingsSnapshot,
} from "../../core/trading-settings.js";
import { TradingSelect } from "../select.js";
import { TradingButton, useTradingValue } from "../primitives.js";

/**
 * Trading settings for consumers whose host has no settings dialog to add a page to. It renders the same fields as
 * the chart's Trading page; each change applies at once, as this dialog always has.
 */
export function PropertiesDialog(props: { session: TradingSession; complete(approved: boolean): void }) {
  const [snapshot, setSnapshot] = createSignal(tradingSettingsSnapshot(props.session));
  onCleanup(subscribeTradingSettings(props.session, () => setSnapshot(tradingSettingsSnapshot(props.session))));
  const error = useTradingValue(props.session.displaySettingsError);
  const idPrefix = `trading-settings-${createUniqueId()}`;
  const descriptionId = (field: TradingSettingsField) => `${idPrefix}-${field.id}-description`;
  const value = (id: string) => snapshot().values[id];
  const disabled = (field: TradingSettingsField) =>
    field.disabled === true || (field.parent !== undefined && value(field.parent) === false);
  const set = (id: string, next: TradingSettingsValue) => {
    try {
      applyTradingSettings(props.session, { [id]: next });
    } catch {
      /* A refused change (for example one-click while confirmation is required) keeps the current value. */
    }
    setSnapshot(tradingSettingsSnapshot(props.session));
  };
  return <>
    <For each={snapshot().sections}>{(section) => (
      <fieldset class="trading-display-settings" data-section={section.id}>
        <legend>{section.title}</legend>
        <For each={section.fields}>{(field) => (
          <div class="trading-settings-row" data-nested={field.parent ? "true" : undefined} data-field-id={field.id}>
            <Show when={field.kind === "checkbox"} fallback={
              <div class="trading-field">
                <span>{field.label}</span>
                <TradingSelect
                  label={field.label}
                  value={String(value(field.id) ?? "")}
                  disabled={disabled(field)}
                  options={field.kind === "select" ? field.options : []}
                  onChange={(next) => set(field.id, next)}
                />
              </div>
            }>
              <label class="trading-check">
                <input
                  type="checkbox"
                  checked={value(field.id) === true}
                  disabled={disabled(field)}
                  aria-describedby={field.kind === "checkbox" && field.description ? descriptionId(field) : undefined}
                  onChange={(event) => set(field.id, event.currentTarget.checked)}
                />
                {field.label}
              </label>
              <Show when={field.kind === "checkbox" && field.select}>{(select) => (
                <TradingSelect
                  label={select().label}
                  value={String(value(select().id) ?? "")}
                  disabled={disabled(field) || value(field.id) !== true}
                  options={select().options}
                  onChange={(next) => set(select().id, next)}
                />
              )}</Show>
              <Show when={field.kind === "checkbox" && field.description}>
                {(description) => <p id={descriptionId(field)} class="trading-settings-description">{description()}</p>}
              </Show>
            </Show>
          </div>
        )}</For>
      </fieldset>
    )}</For>
    <Show when={error()}>
      <p role="alert" class="trading-error">{error()}</p>
      <TradingButton onClick={() => props.session.updateDisplaySettings({})}>Try saving again</TradingButton>
    </Show>
    <TradingButton onClick={() => props.complete(true)}>Done</TradingButton>
  </>;
}
