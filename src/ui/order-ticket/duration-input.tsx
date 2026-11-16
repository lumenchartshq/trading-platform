import { TradingSelect } from "../select.js";
import {
  Show,
  createSignal,
  createEffect,
  createMemo,
  on,
} from "solid-js";
import type {
  OrderDuration,
  OrderDurationMetaInfo,
} from "../../contracts/broker.js";
import {
  displayDateTime,
  expirationSeconds,
} from "../../core/order-duration.js";
export function DurationInput(props: {
  options: readonly OrderDurationMetaInfo[];
  value?: OrderDuration;
  timezone: string;
  disabled: boolean;
  now(): number;
  update(value: OrderDuration): void;
}) {
  const selected = () =>
    props.options.find((option) => option.value === props.value?.type);
  const [dateDraft, setDateDraft] = createSignal<string>(),
    [timeDraft, setTimeDraft] = createSignal<string>();
  const durationType = createMemo(() => props.value?.type);
  createEffect(
    on(durationType, () => {
      setDateDraft(undefined);
      setTimeDraft(undefined);
    }),
  );
  const display = () =>
    props.value?.datetime === undefined
      ? undefined
      : displayDateTime(props.value.datetime, props.timezone);
  const date = () => dateDraft() ?? display()?.date ?? "";
  const time = () => timeDraft() ?? display()?.time ?? "";
  const editable = () => selected()?.hasDatePicker || selected()?.hasTimePicker;
  const error = () =>
    editable() &&
    props.value?.datetime === undefined &&
    (dateDraft() !== undefined || timeDraft() !== undefined);
  function change(dateValue: string, timeValue: string): void {
    const today = displayDateTime(props.now() / 1000, props.timezone)?.date;
    const seconds = expirationSeconds(
      {
        date: selected()?.hasDatePicker ? dateValue : (today ?? ""),
        time: selected()?.hasTimePicker ? timeValue : "00:00",
      },
      props.timezone,
    );
    props.update({ type: props.value!.type, datetime: seconds });
  }
  return (
    <Show when={props.options.length}>
      <details
        class="trading-protection trading-exits trading-extra-settings"
        open
      >
        <summary>Extra settings</summary>
        <div class="trading-field">
          <span>Time in force</span>
          <TradingSelect
            label="Time in force"
            placeholder="Choose time in force"
            value={props.value?.type}
            disabled={props.disabled}
            options={props.options.map((option) => ({
              value: option.value,
              label: option.name,
            }))}
            onChange={(type) => {
              setDateDraft(undefined);
              setTimeDraft(undefined);
              props.update({ type });
            }}
          />
        </div>
        <Show when={editable()}>
          <p class="trading-field-help">
            Expiration timezone: {props.timezone}
            <Show
              when={selected()?.hasDatePicker && !selected()?.hasTimePicker}
            >
              . The order expires at midnight on this date.
            </Show>
          </p>
          <Show when={selected()?.hasDatePicker}>
            <label class="trading-field">
              <span>Expiration date</span>
              <input
                type="date"
                value={date()}
                disabled={props.disabled}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setDateDraft(value);
                  change(value, time());
                }}
              />
            </label>
          </Show>
          <Show when={selected()?.hasTimePicker}>
            <label class="trading-field">
              <span>Expiration time</span>
              <input
                type="time"
                step="1"
                value={time()}
                disabled={props.disabled}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setTimeDraft(value);
                  change(date(), value);
                }}
              />
            </label>
          </Show>
          <Show when={error()}>
            <p role="alert" class="trading-error">
              Choose a valid date and time. Repeated or skipped daylight-saving
              times cannot be used.
            </p>
          </Show>
        </Show>
      </details>
    </Show>
  );
}
