import type { ExtraData, TradingDialogCustomField } from "../contracts/broker.js";
import { equalData } from "./immutable.js";
import { TradingError } from "./errors.js";
export function positionCustomValues(fields: readonly TradingDialogCustomField[], extra: Readonly<ExtraData> | undefined, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return Object.fromEntries(fields.map(field => [field.id, Object.hasOwn(overrides, field.id) ? overrides[field.id] : extra?.[field.id] ?? field.value]));
}
/** Dialog defaults prepare a draft; only an explicit broker value confirms it. */
export function positionCustomMatches(values: Readonly<Record<string, unknown>> | undefined, extra: Readonly<ExtraData> | undefined): boolean {
  return Object.entries(values ?? {}).every(([id, value]) => extra !== undefined && Object.hasOwn(extra, id) && equalData(extra[id], value));
}
export function validatePositionCustomFields(values: Readonly<Record<string, unknown>> | undefined, fields: readonly TradingDialogCustomField[], extra: Readonly<ExtraData> | undefined): Record<string, unknown> | undefined {
  if (values === undefined) return;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TradingError("invalid-input", "Choose valid protection fields.");
  const prepared = structuredClone(values), current = positionCustomValues(fields, extra);
  for (const [id, value] of Object.entries(prepared)) {
    const field = fields.find(field => field.id === id);
    if (!field) throw new TradingError("invalid-input", "This protection field is unavailable.");
    const changed = !equalData(current[id], value);
    if (changed && ("preventModify" in field && field.preventModify || field.inputType === "Checkbox" && !field.supportModify))
      throw new TradingError("unsupported", "This protection field cannot be changed.");
    if (field.inputType === "ComboBox" && (typeof value !== "string" || !field.items.some(item => item.value === value)) ||
        field.inputType === "Checkbox" && typeof value !== "boolean" || field.inputType === "TextField" && typeof value !== "string")
      throw new TradingError("invalid-input", `Choose a valid value for ${field.title}.`);
    let validated = value;
    if (field.inputType === "TextWithCheckBox") {
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || !("checked" in value) || typeof value.checked !== "boolean")
        throw new TradingError("invalid-input", `Choose a valid value for ${field.title}.`);
      validated = value.text;
    }
    if ("validator" in field && field.validator) {
      if (typeof validated !== "string") throw new TradingError("invalid-input", `Choose a valid value for ${field.title}.`);
      const result = field.validator(validated);
      if (!result.valid) throw new TradingError("invalid-input", result.errorMessage);
    }
  }
  return prepared;
}
