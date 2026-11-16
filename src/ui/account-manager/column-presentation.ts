import { StandardFormatterName } from "../../contracts/broker.js";
import type {
  AccountManagerColumn,
  FieldRef,
} from "../../contracts/broker.js";
import { fieldValue } from "../../compat/formatters.js";

/** Tooltip maps use the same owned field paths as formatter inputs; broker text stays plain text. */
export function columnTooltip(
  row: unknown,
  column: AccountManagerColumn,
): string | undefined {
  if (!column.tooltipProperty) return undefined;
  const tooltips = fieldValue(row, column.tooltipProperty);
  if (!tooltips || typeof tooltips !== "object" || Array.isArray(tooltips))
    return undefined;
  const values = new Set<string>();
  for (const field of column.dataFields as FieldRef[]) {
    let value = fieldValue(tooltips, field);
    if (value === undefined && Array.isArray(field))
      value = fieldValue(tooltips, field.join("."));
    if (typeof value === "string" && value.length) values.add(value);
  }
  return values.size ? [...values].join("\n") : undefined;
}

/** Only the two pinned price formatters opt into standard directional highlighting. */
export function columnPriceTone(
  column: AccountManagerColumn,
  values: readonly unknown[],
  previous?: readonly unknown[],
): "positive" | "negative" | undefined {
  if (
    !column.highlightDiff ||
    (column.formatter !== StandardFormatterName.FormatPrice &&
      column.formatter !== StandardFormatterName.FormatPriceForexSup)
  )
    return undefined;
  const current = values[0],
    before = previous?.[0];
  if (
    typeof current !== "number" ||
    typeof before !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(before) ||
    current === before
  )
    return undefined;
  return current > before ? "positive" : "negative";
}
