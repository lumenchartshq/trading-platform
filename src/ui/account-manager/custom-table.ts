import type { AccountManagerTable } from "../../contracts/broker.js";
import type { TradingClock } from "../../contracts/ports.js";
import { EntityStore } from "../../core/entity-store.js";
import { ValueStore } from "../../core/value-store.js";
import { entityReader, valueReader } from "../../core/readers.js";
import { systemClock } from "../../core/clock.js";
import { TradingError } from "../../core/errors.js";
import { snapshot } from "../../core/immutable.js";
interface CustomRow {
  id: string;
  [key: string]: unknown;
}
/** Cursor pagination and broker row delegates share one ordered reconciliation path. */
export function createCustomTableController(
  table: AccountManagerTable,
  clock: TradingClock = systemClock,
) {
  const rows = new EntityStore<CustomRow>((row) => {
    if (typeof row.id !== "string" || !row.id)
      throw new TradingError(
        "invalid-input",
        "A custom account row is missing its identity.",
      );
  });
  const state = new ValueStore({
    loading: false,
    done: false,
    error: undefined as string | undefined,
  });
  const owner = {};
  const cursors = new Set<string>();
  let cursor: string | undefined,
    sequence = 0,
    disposed = false,
    timer: unknown;
  let cancelRead: ((reason: unknown) => void) | undefined;
  let buffered: ({ row: CustomRow } | { remove: string })[] = [];
  const changed = (value: {}) => {
    if (disposed) return;
    const row = snapshot(value) as CustomRow;
    if (state.get().loading) buffered.push({ row });
    else rows.upsert(row);
  };
  const deleted = (id: string) => {
    if (disposed) return;
    if (state.get().loading) buffered.push({ remove: id });
    else rows.remove(id);
  };
  table.changeDelegate.subscribe(owner, changed);
  table.deleteDelegate?.subscribe(owner, deleted);
  async function loadNext(): Promise<void> {
    if (disposed || state.get().loading || state.get().done) return;
    const request = ++sequence,
      first = cursor === undefined;
    state.set({ loading: true, done: false, error: undefined });
    const timeout = new Promise<never>((_, reject) => {
      cancelRead = reject;
      timer = clock.setTimeout(
        () =>
          reject(
            new TradingError(
              "broker-unavailable",
              "Account rows took too long to load.",
            ),
          ),
        15000,
      );
    });
    try {
      const page = await Promise.race([table.getData(cursor), timeout]);
      if (disposed || request !== sequence) return;
      const normalized = page.map((value) => snapshot(value) as CustomRow);
      for (const row of normalized)
        if (typeof row.id !== "string" || !row.id)
          throw new TradingError(
            "invalid-input",
            "A custom account row is missing its identity.",
          );
      const nextCursor = normalized.at(-1)?.id;
      if (nextCursor !== undefined && cursors.has(nextCursor))
        throw new TradingError(
          "broker-unavailable",
          "The broker repeated an account page. Refresh to try again.",
        );
      rows.transaction(() => {
        if (first) rows.replace(normalized);
        else for (const row of normalized) rows.upsert(row);
        for (const update of buffered.splice(0)) {
          if ("row" in update) rows.upsert(update.row);
          else rows.remove(update.remove);
        }
      });
      if (nextCursor !== undefined) {
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      state.set({
        loading: false,
        done: !page.length || !table.flags?.supportPagination,
        error: undefined,
      });
    } catch (cause) {
      if (!disposed && request === sequence) {
        rows.transaction(() => {
          for (const update of buffered.splice(0)) {
            if ("row" in update) rows.upsert(update.row);
            else rows.remove(update.remove);
          }
        });
        state.set({
          loading: false,
          done:
            cause instanceof Error &&
            cause.message.includes("repeated an account page"),
          error:
            cause instanceof Error
              ? cause.message
              : "Account rows are unavailable.",
        });
      }
    } finally {
      if (request === sequence && timer !== undefined) {
        clock.clearTimeout(timer);
        timer = undefined;
        cancelRead = undefined;
      }
    }
  }
  return {
    rows: entityReader(rows),
    state: valueReader(state),
    loadNext,
    destroy() {
      if (disposed) return;
      disposed = true;
      sequence++;
      cancelRead?.(
        TradingError.disposed("This account page is closed."),
      );
      cancelRead = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      table.changeDelegate.unsubscribe(owner, changed);
      table.deleteDelegate?.unsubscribe(owner, deleted);
      buffered = [];
      rows.destroy();
      state.destroy();
    },
  };
}
