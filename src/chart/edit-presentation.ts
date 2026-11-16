import type {
  TradingChartBinding,
  ReadonlyValue,
  TradingOverlayHandle,
  TradingOverlayPatch,
  TradingProtectionView,
} from "../contracts/ports.js";
import type { ChartOrderEdit } from "../core/chart-order-edit.js";
import { proposedEditPoint, type EditPreviewPoint } from "./edit-preview.js";
import type { OverlayEntityKind, Projection } from "./overlay-projection.js";
import type { Overlay, Owner } from "./overlay-types.js";
import { reviewActions, reviewProtection, type ReviewLock } from "./review-lock.js";

export interface EditPresentationHost {
  /** The session's single unsent chart edit. */
  readonly edits: ReadonlyValue<Readonly<ChartOrderEdit> | undefined>;
  readonly owners: ReadonlyMap<string, Owner>;
  readonly ownerKey: (binding: TradingChartBinding) => string;
  /** Overlay keys painted with an edit group: the group's own key and its child exits. */
  readonly groupKeys: (group: string) => readonly string[];
  readonly keyFor: (kind: OverlayEntityKind, id: string) => string;
  readonly updateOverlay: (handle: TradingOverlayHandle, patch: TradingOverlayPatch) => void;
  readonly updateProtectionPreview: (
    owner: Owner,
    overlay: Overlay,
    point: EditPreviewPoint,
    gestureId?: string,
  ) => void;
}
interface Presentation {
  readonly token: number;
  readonly binding: TradingChartBinding;
  readonly owner: string;
  readonly key: string;
  readonly group: string;
  readonly review?: { readonly lock: ReviewLock; readonly point?: EditPreviewPoint };
}

/**
 * How the session's unsent edit shows on the chart: which overlay displays it, the review lock that mutes its
 * group once the user released it, and repainting the group when the edit changes or ends.
 */
export function createEditPresentation(host: EditPresentationHost) {
  let presentation: Presentation | undefined;
  // begin() publishes synchronously. A confirmed child exit displays its parent's edit on the child.
  let beginningDisplay: string | undefined;
  function lockFor(owner: Owner, projection: Projection): ReviewLock | undefined {
    if (
      presentation?.owner === host.ownerKey(owner.binding) &&
      presentation.group === (projection.spec.group ?? projection.spec.key)
    )
      return presentation.review?.lock;
  }
  function shownProtection(owner: Owner, projection: Projection, preview?: TradingProtectionView) {
    const protection = preview ?? projection.spec.protection;
    const lock = lockFor(owner, projection);
    if (!lock) return protection;
    return { ...reviewProtection(projection.spec.key, protection ?? { handles: [] }, lock), muted: true };
  }
  function editTarget(display: Presentation) {
    const owner = host.owners.get(display.owner);
    const overlay = owner?.overlays.get(display.key);
    return owner && overlay ? { owner, overlay } : undefined;
  }
  function showSavedEdit(display: Presentation) {
    const point = display.review?.point;
    const target = editTarget(display);
    if (!target || !point) return;
    if (point.leg || target.overlay.projection.spec.protection?.movingLeg)
      host.updateProtectionPreview(target.owner, target.overlay, point);
    else host.updateOverlay(target.overlay.handle, { price: point.price });
  }
  function refreshPreview() {
    const display = presentation;
    if (!display) return;
    if (display.review) {
      showSavedEdit(display);
      return;
    }
    const target = editTarget(display);
    if (!target?.overlay.previewEvent) return;
    const event = target.overlay.previewEvent;
    const point = target.overlay.parentEdit ? { price: event.price, leg: target.overlay.parentEdit.leg } : event;
    host.updateProtectionPreview(target.owner, target.overlay, point, event.gestureId);
  }
  function paintEditGroup(display: Presentation) {
    const owner = host.owners.get(display.owner);
    if (!owner) return;
    const keys = new Set([display.key, ...host.groupKeys(display.group)]);
    for (const key of keys) {
      const overlay = owner.overlays.get(key);
      if (!overlay) continue;
      const projection = overlay.projection;
      host.updateOverlay(overlay.handle, {
        protection: shownProtection(owner, projection, overlay.proposedProtection),
        actions: reviewActions(key, projection.spec.actions, lockFor(owner, projection)),
      });
    }
  }
  function releaseEdit(edit: Readonly<ChartOrderEdit>, point: EditPreviewPoint | undefined) {
    const display = presentation;
    if (!display || display.token !== edit.token || display.review) return;
    const released = { ...display, review: { lock: { reviewedKey: display.key, leg: edit.leg }, point } };
    presentation = released;
    paintEditGroup(released);
    showSavedEdit(released);
  }
  function clearPresentation() {
    const display = presentation;
    presentation = undefined;
    if (!display) return;
    const target = editTarget(display);
    if (target) {
      target.overlay.proposedProtection = undefined;
      host.updateOverlay(target.overlay.handle, { price: target.overlay.projection.spec.price });
    }
    paintEditGroup(display);
  }
  const release = host.edits.subscribe((edit) => {
    if (presentation?.token !== edit?.token) {
      clearPresentation();
      if (!edit) return;
      const owner = host.ownerKey(edit.binding);
      const key = beginningDisplay ?? host.keyFor(edit.kind, edit.id);
      const group = host.owners.get(owner)?.overlays.get(key)?.projection.spec.group ?? key;
      presentation = { token: edit.token, binding: edit.binding, owner, key, group };
    }
    // Ticket edits keep the original chart price. Only the initial handoff acquires the lock.
    if (edit && edit.phase !== "dragging" && !presentation?.review) releaseEdit(edit, proposedEditPoint(edit));
  });
  return {
    lockFor,
    shownProtection,
    releaseEdit,
    refreshPreview,
    /** Symbol of the chart showing the edit, if any. */
    symbol: (): string | undefined => presentation?.binding.symbol,
    /** Runs `begin` with the edit displayed on `key` (a dragged child exit shows its parent's edit). */
    displayOn<T>(key: string, begin: () => T): T {
      beginningDisplay = key;
      try {
        return begin();
      } finally {
        beginningDisplay = undefined;
      }
    },
    destroy(): void {
      release();
      presentation = undefined;
    },
  };
}
