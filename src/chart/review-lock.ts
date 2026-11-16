import type {
  TradingOverlayAction,
  TradingProtectionLeg,
  TradingProtectionView,
} from "../contracts/ports.js";

/** A released proposal locks its protection group while the ticket owns the edit. */
export interface ReviewLock {
  /** Overlay showing the proposal. */
  readonly reviewedKey: string;
  /** TP/SL leg under review; undefined for an entry price review. */
  readonly leg?: TradingProtectionLeg;
}

/** Protection reviews lock every group member. Entry reviews only lock sibling lines. */
export function reviewLineLocked(key: string, lock: ReviewLock | undefined): boolean {
  return !!lock && (lock.leg !== undefined || key !== lock.reviewedKey);
}

/** Protection a line shows during a review; unchanged outside it. */
export function reviewProtection(
  key: string,
  protection: TradingProtectionView,
  lock: ReviewLock | undefined,
): TradingProtectionView {
  if (!reviewLineLocked(key, lock)) return protection;
  return {
    ...protection,
    handles: [],
    lockedHandles: key === lock?.reviewedKey ? protection.handles : undefined,
  };
}

/** A locked line keeps its actions except chart modify, which also owns dragging. */
export function reviewActions(
  key: string,
  actions: readonly TradingOverlayAction[],
  lock: ReviewLock | undefined,
): readonly TradingOverlayAction[] {
  return reviewLineLocked(key, lock) ? actions.filter((action) => action !== "modify") : actions;
}
