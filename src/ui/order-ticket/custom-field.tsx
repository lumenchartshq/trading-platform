import { Show } from "solid-js";
import type { TradingDialogCustomField } from "../../contracts/broker.js";
import { TradingSelect } from "../select.js";
export function CustomField(props: {
  field: TradingDialogCustomField;
  value: unknown;
  disabled: boolean;
  /** Modifying an existing order: checkboxes stay editable only with `supportModify`. */
  modifying: boolean;
  update(value: unknown): void;
}) {
  const field = () => props.field;
  const disabled = () => {
    const value = field();
    if (props.disabled) return true;
    if ("preventModify" in value && value.preventModify === true) return true;
    return (
      props.modifying && value.inputType === "Checkbox" && !("supportModify" in value && value.supportModify === true)
    );
  };
  const help = () => {
    const value = field();
    return "help" in value && typeof value.help === "string" && value.help ? value.help : undefined;
  };
  const helpId = `trading-custom-help-${props.field.id}`;
  const titleId = `trading-custom-title-${props.field.id}`;
  const textMasked = () => {
    const value = field();
    return (
      value.inputType === "TextWithCheckBox" &&
      (value as { customInfo?: { asterix?: boolean } }).customInfo?.asterix === true
    );
  };
  const masked = () => {
    const value = field();
    return "maskWithAsterisk" in value && value.maskWithAsterisk === true;
  };
  const placeholder = () => {
    const value = field();
    return "placeHolder" in value && typeof value.placeHolder === "string" ? value.placeHolder : undefined;
  };
  // The text-with-checkbox kind has two controls, so its checkbox gets its own label instead of a nested one.
  const textWithCheckBox = () => (
    <div class="trading-field">
      <span id={titleId}>{field().title}</span>
      <input
        type={textMasked() ? "password" : "text"}
        aria-labelledby={titleId}
        disabled={disabled()}
        value={(props.value as { text?: string })?.text ?? ""}
        onInput={(event) =>
          props.update({
            ...(props.value as object),
            text: event.currentTarget.value,
          })
        }
      />
      <label class="trading-check">
        <input
          type="checkbox"
          disabled={disabled()}
          checked={(props.value as { checked?: boolean })?.checked === true}
          onChange={(event) =>
            props.update({
              ...(props.value as object),
              checked: event.currentTarget.checked,
            })
          }
        />
        {(field() as Extract<TradingDialogCustomField, { inputType: "TextWithCheckBox" }>).customInfo.checkboxTitle}
      </label>
    </div>
  );
  return (
    <Show when={field().inputType !== "TextWithCheckBox"} fallback={textWithCheckBox()}>
      <label class="trading-field">
        <span>{field().title}</span>
        <Show when={field().inputType === "Checkbox"}>
          <input
            type="checkbox"
            checked={props.value === true}
            disabled={disabled()}
            aria-describedby={help() ? helpId : undefined}
            onChange={(event) => props.update(event.currentTarget.checked)}
          />
          <Show when={help()}>
            {(text) => (
              <small id={helpId} class="trading-field-help">
                {text()}
              </small>
            )}
          </Show>
        </Show>
        <Show when={field().inputType === "ComboBox"}>
          <TradingSelect
            label={field().title}
            disabled={disabled()}
            value={props.value === undefined ? undefined : String(props.value)}
            options={(field() as Extract<TradingDialogCustomField, { inputType: "ComboBox" }>).items.map((item) => ({
              value: item.value,
              label: item.text,
            }))}
            onChange={(value) => props.update(value)}
          />
        </Show>
        <Show when={field().inputType === "TextField"}>
          <input
            type={masked() ? "password" : "text"}
            placeholder={placeholder()}
            disabled={disabled()}
            value={String(props.value ?? "")}
            onInput={(event) => props.update(event.currentTarget.value)}
          />
        </Show>
      </label>
    </Show>
  );
}
