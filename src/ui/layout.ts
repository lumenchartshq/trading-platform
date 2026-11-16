/** Exclusive width thresholds; trading.css media queries are checked against these values. */
export const COMPACT_WIDTH = 900;
export const NARROW_WIDTH = 600;

/** Wrapped account controls still leave room for rows on narrow hosts. Host geometry remains authoritative. */
export function accountDockHeight(preferred: number, width: number, maximum: number): number {
  return Math.min(maximum, Math.max(width < NARROW_WIDTH ? 320 : 160, preferred));
}
