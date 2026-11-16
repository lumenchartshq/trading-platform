import type { Order } from "../contracts/broker.js";

/** Default most order-history rows kept from one read. */
export const DEFAULT_HISTORY_LIMIT = 5000;

/**
 * Keeps the newest `limit` history rows: by `updateTime` when every row has one, otherwise the last rows in
 * arrival order. Returns the kept rows (in their original order) and how many were dropped.
 */
export function limitHistory<T extends Pick<Order, "updateTime">>(
  rows: readonly T[],
  limit: number,
): { readonly rows: readonly T[]; readonly dropped: number } {
  if (!Array.isArray(rows) || rows.length <= limit) return { rows, dropped: 0 };
  const timed = rows.every((row) => typeof row?.updateTime === "number" && Number.isFinite(row.updateTime));
  if (!timed) return { rows: rows.slice(rows.length - limit), dropped: rows.length - limit };
  const kept = new Set(
    rows
      .map((row, index) => ({ index, time: row.updateTime! }))
      .sort((a, b) => b.time - a.time || b.index - a.index)
      .slice(0, limit)
      .map((entry) => entry.index),
  );
  return { rows: rows.filter((_, index) => kept.has(index)), dropped: rows.length - limit };
}
