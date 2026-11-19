import type { TradingDockKind, TradingDockSizing, TradingPresentationPort } from "../contracts/ports.js";
/** Exclusive width thresholds; trading.css media queries are checked against these values. */
export const COMPACT_WIDTH = 900;
export const NARROW_WIDTH = 600;

/** Wrapped account controls still leave room for rows on narrow hosts. Host geometry remains authoritative. */
export function accountDockHeight(preferred: number, width: number, maximum: number): number {
  return Math.min(maximum, Math.max(width < NARROW_WIDTH ? 320 : 160, preferred));
}

type SizingPresentation = Pick<TradingPresentationPort, "dockSizing">;

/** Who sizes a dock, the one place the platform reads it. An absent or unknown answer means the platform does. */
export function dockSizing(presentation: SizingPresentation, kind: TradingDockKind): TradingDockSizing {
  const sizing = presentation.dockSizing?.(kind);
  return sizing === "host" || sizing === "fixed" ? sizing : "platform";
}

/** Only a platform-sized dock renders a resize handle. */
export function dockResizable(presentation: SizingPresentation, kind: TradingDockKind): boolean {
  return dockSizing(presentation, kind) === "platform";
}

/** A fixed host box: the panel keeps its normal mode and offers no controls that would change its size. */
export function dockFixed(presentation: SizingPresentation, kind: TradingDockKind): boolean {
  return dockSizing(presentation, kind) === "fixed";
}

/** A platform-sized side pane becomes a compact overlay on narrow screens. A host-sized one is a page column and never does. */
export function compactSidePane(presentation: SizingPresentation, width: number): boolean {
  return dockResizable(presentation, "ticket") && width < COMPACT_WIDTH;
}
