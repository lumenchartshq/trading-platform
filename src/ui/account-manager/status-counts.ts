import type { EntityChange, EntityReader } from "../../core/entity-store.js";

/** Row counts per status, maintained from change sets so an update costs only its changed rows. */
export function createStatusCounts(
  reader: EntityReader<{ id: string; status?: unknown }>,
  onChange: (counts: ReadonlyMap<unknown, number>, total: number) => void,
) {
  const statuses = new Map<string, unknown>();
  const counts = new Map<unknown, number>();
  const adjust = (status: unknown, delta: number) => {
    const next = (counts.get(status) ?? 0) + delta;
    if (next) counts.set(status, next);
    else counts.delete(status);
  };
  const track = (id: string) => {
    if (statuses.has(id)) adjust(statuses.get(id), -1);
    const row = reader.get(id);
    if (!row) {
      statuses.delete(id);
      return;
    }
    statuses.set(id, row.status);
    adjust(row.status, 1);
  };
  for (const id of reader.ids()) track(id);
  const publish = () => onChange(new Map(counts), statuses.size);
  publish();
  return reader.subscribeChanges((change: EntityChange) => {
    for (const id of change.added) track(id);
    for (const id of change.updated) track(id);
    for (const id of change.removed) track(id);
    publish();
  });
}
