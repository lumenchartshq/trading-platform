import type { FieldRef } from "../../contracts/broker.js";
import type { EntityChange, EntityReader } from "../../core/entity-store.js";
import type { FinancialValue } from "../../core/trading-state.js";
interface PositionRow {
  readonly id: string;
  readonly extra?: Record<string, unknown>;
  readonly unrealizedPl?: number;
  readonly pl?: number;
  readonly visiblePL?: number;
}
/** Includes formatter inputs, active sorting and search dependencies. */
export function needsPositionProfit(
  fields: readonly FieldRef[],
  wholeRow: boolean,
): boolean {
  if (wholeRow) return true;
  return fields.some((field) => {
    if (Array.isArray(field))
      return field[0] === "extra" && (field.length === 1 || field[1] === "pl");
    return [
      "extra",
      "unrealizedPl",
      "pl",
      "visiblePL",
      "unrealizedPlQty",
      "unrealizedPlPercent",
    ].includes(String(field));
  });
}
const emptyIds: readonly string[] = Object.freeze([]);
interface Cached<T> {
  readonly baseRevision: number;
  readonly financialRevision: number;
  readonly policyRevision: number;
  readonly base: Readonly<T>;
  readonly row: Readonly<T>;
}
/** Table-only money updates never mutate the broker position used by chart overlays. */
export function createPositionTableReader<T extends PositionRow>(
  source: EntityReader<T>,
  financial: EntityReader<FinancialValue>,
  individual = false,
  estimates?: EntityReader<FinancialValue>,
) {
  const cache = new Map<string, Cached<T>>(),
    present = new Set(source.ids());
  const listeners = new Set<(change: EntityChange) => void>();
  let enabled = true,
    policyRevision = 0,
    eventRevision = 0,
    disposed = false;
  const financialSource = () => (enabled ? financial : estimates);
  const get = (id: string): Readonly<T> | undefined => {
    if (disposed) return undefined;
    const baseRevision = source.revision(id),
      financialRevision = financialSource()?.revision(id) ?? 0,
      previous = cache.get(id);
    if (
      previous?.baseRevision === baseRevision &&
      previous.financialRevision === financialRevision &&
      previous.policyRevision === policyRevision
    )
      return previous.row;
    const base =
      previous?.baseRevision === baseRevision ? previous.base : source.get(id);
    if (!base) {
      cache.delete(id);
      return undefined;
    }
    const value = financialSource()?.get(id)?.value;
    let row = base;
    if (value !== undefined || (!enabled && estimates)) {
      const extra =
        base.extra?.pl === value
          ? base.extra
          : Object.freeze({ ...base.extra, pl: value });
      row = Object.freeze({
        ...base,
        extra,
        unrealizedPl: value,
        ...(individual ? { pl: value, visiblePL: value } : {}),
      });
      if (
        previous?.base === base &&
        previous.row.extra?.pl === value &&
        previous.row.unrealizedPl === value &&
        (!individual ||
          (previous.row.pl === value && previous.row.visiblePL === value))
      )
        row = previous.row;
    }
    cache.set(id, {
      baseRevision,
      financialRevision,
      policyRevision,
      base,
      row,
    });
    return row;
  };
  const publish = (change: Omit<EntityChange, "revision">) => {
    if (
      disposed ||
      (!change.added.length && !change.updated.length && !change.removed.length)
    )
      return;
    const event = Object.freeze({
      added: Object.freeze([...change.added]),
      updated: Object.freeze([...change.updated]),
      removed: Object.freeze([...change.removed]),
      revision: ++eventRevision,
    });
    for (const listener of [...listeners]) listener(event);
  };
  const releaseSource = source.subscribeChanges((change) => {
    if (!listeners.size)
      for (const id of [...change.added, ...change.updated]) cache.delete(id);
    for (const id of change.removed) {
      present.delete(id);
      cache.delete(id);
    }
    for (const id of change.added) present.add(id);
    publish(change);
  });
  const financialChanged = (change: EntityChange) => {
    if (!listeners.size) {
      for (const id of [...change.added, ...change.updated, ...change.removed])
        cache.delete(id);
      return;
    }
    const updated: string[] = [];
    for (const id of [...change.added, ...change.updated, ...change.removed]) {
      if (!present.has(id)) continue;
      const previous = cache.get(id)?.row,
        row = get(id);
      if (row && row !== previous) updated.push(id);
    }
    publish({ added: [], updated, removed: [] });
  };
  const releaseFinancial = financial.subscribeChanges((change) => {
    if (enabled) financialChanged(change);
  });
  const releaseEstimates = estimates?.subscribeChanges((change) => {
    if (!enabled) financialChanged(change);
  });
  const reader: EntityReader<T> = Object.freeze({
    ids: () => (disposed ? emptyIds : source.ids()),
    get,
    revision: (id: string) => {
      if (disposed) return 0;
      return (
        source.revision(id) +
        (financialSource()?.revision(id) ?? 0) +
        policyRevision
      );
    },
    subscribeChanges(listener: (change: EntityChange) => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    reader,
    setEnabled(value: boolean): void {
      if (disposed || value === enabled) return;
      enabled = value;
      policyRevision++;
      publish({ added: [], updated: source.ids(), removed: [] });
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      releaseSource();
      releaseFinancial();
      releaseEstimates?.();
      listeners.clear();
      cache.clear();
      present.clear();
    },
  };
}
