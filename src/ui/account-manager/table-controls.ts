import {
  OrderStatus,
  OrderStatusFilter,
} from "../../contracts/broker.js";
import type {
  AccountManagerColumn,
  FieldRef,
} from "../../contracts/broker.js";
import { fieldValue } from "../../compat/formatters.js";
export const defaultStatusFilters: readonly OrderStatus[] = Object.freeze([
  OrderStatus.Working,
  OrderStatus.Inactive,
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Rejected,
]);
export interface TableFilter {
  readonly query: string;
  readonly status: OrderStatus | OrderStatusFilter.All;
  readonly fields: readonly FieldRef[];
}
export function matchesTableFilter(
  row: Readonly<Record<string, unknown>>,
  filter: TableFilter,
): boolean {
  if (filter.status !== OrderStatusFilter.All && row.status !== filter.status)
    return false;
  const query = filter.query.trim().toLowerCase();
  if (!query) return true;
  return filter.fields.some((field) => {
    const value = fieldValue(row, field);
    return (
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") &&
      String(value).toLowerCase().includes(query)
    );
  });
}
const maxColumnPreferenceLength = 32768;
/** Only versioned boolean display choices are retained; no broker row data is persisted. */
export function readColumnChoices(
  input: string | undefined,
  columns: readonly AccountManagerColumn[],
): ReadonlyMap<string, boolean> {
  if (!input || input.length > maxColumnPreferenceLength) return new Map();
  try {
    const value: unknown = JSON.parse(input);
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("columns" in value) ||
      !Array.isArray(value.columns)
    )
      return new Map();
    const known = new Set(columns.map((column) => column.id)),
      result = new Map<string, boolean>();
    for (const entry of value.columns) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        known.has(entry[0]) &&
        typeof entry[1] === "boolean"
      )
        result.set(entry[0], entry[1]);
    }
    return result;
  } catch {
    return new Map();
  }
}
export function visibleTableColumns(
  columns: readonly AccountManagerColumn[],
  choices: ReadonlyMap<string, boolean>,
): readonly AccountManagerColumn[] {
  return columns.filter(
    (column) =>
      column.notHideable || (choices.get(column.id) ?? !column.hideByDefault),
  );
}
export function serializeColumnChoices(
  columns: readonly AccountManagerColumn[],
  choices: ReadonlyMap<string, boolean>,
): string {
  const serialized = JSON.stringify({
    version: 1,
    columns: columns
      .filter((column) => choices.has(column.id) && !column.notHideable)
      .map((column) => [column.id, choices.get(column.id)]),
  });
  if (serialized.length > maxColumnPreferenceLength)
    throw new Error("Too many column choices to save.");
  return serialized;
}
