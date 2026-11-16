import type { FieldRef } from "../../contracts/broker.js";
import type { EntityReader } from "../../core/entity-store.js";
import { ValueStore } from "../../core/value-store.js";
import { valueReader } from "../../core/readers.js";
import { equalData } from "../../core/immutable.js";
import { fieldValue } from "../../compat/formatters.js";
interface Sort {
  readonly field: FieldRef;
  readonly ascending: boolean;
}
/** Retains every row ID; the view renders a window, while mutations only reindex affected IDs. */
export function createTableModel<T extends { id: string }>(
  reader: EntityReader<T>,
) {
  const ids = new ValueStore<readonly string[]>(reader.ids());
  let sort: Sort | undefined;
  let visible = new Set(reader.ids());
  let filter: (row: Readonly<T>) => boolean = () => true;
  const sortValues = new Map<string, unknown>();
  const compare = (a: string, b: string): number => {
    const left = sortValues.get(a),
      right = sortValues.get(b);
    let result = 0;
    if (typeof left === "number" && typeof right === "number")
      result = left - right;
    else if (left == null && right != null) result = -1;
    else if (left != null && right == null) result = 1;
    else result = String(left ?? "").localeCompare(String(right ?? ""));
    if (sort && !sort.ascending) result = -result;
    return result || a.localeCompare(b);
  };
  function rebuild(): void {
    sortValues.clear();
    const selected = reader.ids().filter((id) => {
      const row = reader.get(id);
      if (!row || !filter(row)) return false;
      if (sort) sortValues.set(id, fieldValue(row, sort.field));
      return true;
    });
    if (sort) selected.sort(compare);
    visible = new Set(selected);
    ids.set(selected);
  }
  const release = reader.subscribeChanges((change) => {
    let next: string[] | undefined;
    for (const id of [...change.removed, ...change.updated, ...change.added]) {
      const row = reader.get(id),
        matches = row !== undefined && filter(row);
      const current = next ?? ids.get();
      const value = row && sort ? fieldValue(row, sort.field) : undefined;
      const changedSort = !!sort && !equalData(value, sortValues.get(id));
      if (
        matches &&
        visible.has(id) &&
        !changedSort &&
        !change.added.includes(id) &&
        !change.removed.includes(id)
      )
        continue;
      if (!matches && !visible.has(id)) continue;
      if (!next) next = [...current];
      const old = next.indexOf(id);
      if (old >= 0) next.splice(old, 1);
      sortValues.delete(id);
      if (!matches) continue;
      sortValues.set(id, value);
      if (!sort) {
        next.push(id);
        continue;
      }
      let left = 0,
        right = next.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (compare(next[middle], id) <= 0) left = middle + 1;
        else right = middle;
      }
      next.splice(left, 0, id);
    }
    if (next) {
      visible = new Set(next);
      ids.set(next);
    }
  });
  return {
    ids: valueReader(ids),
    setSort(field: FieldRef, ascending: boolean) {
      sort = { field, ascending };
      rebuild();
    },
    setFilter(predicate: (row: Readonly<T>) => boolean) {
      filter = predicate;
      rebuild();
    },
    destroy() {
      release();
      ids.destroy();
      sortValues.clear();
    },
  };
}
