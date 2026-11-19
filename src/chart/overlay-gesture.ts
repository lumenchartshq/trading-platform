import type { IndividualPosition, InstrumentInfo, Position, Side } from "../contracts/broker.js";
import type {
  TradingOverlayEvent,
  TradingOverlayHandle,
  TradingOverlayPatch,
  TradingProtectionLeg,
  TradingProtectionView,
} from "../contracts/ports.js";
import type { ChartOrderEdit } from "../core/chart-order-edit.js";
import { positionProtectionReference } from "../core/financial-rules.js";
import type { TradingSession } from "../core/session.js";
import { editPreviewProtection, type EditPreviewPoint } from "./edit-preview.js";
import { normalizeOverlayEvent } from "./overlay-events.js";
import type { OverlayEntityKind, Projection } from "./overlay-projection.js";
import type { Overlay, OverlayAction, Owner } from "./overlay-types.js";
import type { createParentLinks } from "./parent-links.js";
import { reviewLineLocked, type ReviewLock } from "./review-lock.js";
import type { ProfitAccount } from "../core/position-profit-currency.js";

/** What a chart gesture needs from its coordinator; everything is passed explicitly, there is no event bus. */
export interface GestureHost {
  readonly session: TradingSession;
  readonly onAction: (action: OverlayAction) => void | Promise<unknown>;
  readonly onError: (error: unknown) => void;
  readonly safely: (work: () => void) => void;
  readonly instrument: (symbol: string) => InstrumentInfo | undefined;
  readonly exitText: (
    symbol: string,
    side: Side,
    qty: number,
    entry: number | undefined,
    exit: number,
    account: ProfitAccount,
  ) => string;
  readonly currentProfitAccount: () => ProfitAccount;
  readonly lockFor: (owner: Owner, projection: Projection) => ReviewLock | undefined;
  readonly shownProtection: (
    owner: Owner,
    projection: Projection,
    preview?: TradingProtectionView,
  ) => TradingProtectionView | undefined;
  readonly releaseEdit: (edit: Readonly<ChartOrderEdit>, point: EditPreviewPoint | undefined) => void;
  readonly displayOn: <T>(key: string, begin: () => T) => T;
  readonly updateOverlay: (handle: TradingOverlayHandle, patch: TradingOverlayPatch) => void;
  readonly multipleExitLevels: (symbol: string) => boolean;
  readonly pipFinanceNeeded: (symbol: string) => boolean;
  readonly completedParent: ReturnType<typeof createParentLinks>["completedParent"];
  readonly confirmedExitParent: (
    overlay: Overlay,
    kind: OverlayEntityKind,
    id: string,
  ) => ReturnType<ReturnType<typeof createParentLinks>["confirmedExitParent"]>;
}

/**
 * One semantic owner per chart gesture: drag start opens the edit (and its pip lease), previews are pure
 * maths, commit dispatches one action or ends the gesture, and cancel paths restore the broker presentation.
 */
export function createOverlayGestures(host: GestureHost) {
  /** Whether a gesture on this leg (or a body move) is still allowed by the current projection. */
  function gestureEligible(projection: Projection, leg: TradingProtectionLeg | undefined): boolean {
    return leg ? !!projection.spec.protection?.handles.includes(leg) : projection.spec.actions.includes("modify");
  }
  /** Shows a proposed protection price on an overlay; gesture events must belong to its active gesture. */
  function updateProtectionPreview(owner: Owner, overlay: Overlay, point: EditPreviewPoint, gestureId?: string): void {
    if (gestureId !== undefined && gestureId !== overlay.gestureId) return;
    const edit = host.session.chartEdits.state.get(),
      instrument = host.instrument(owner.binding.symbol);
    if (!edit || !instrument) return;
    const protection = editPreviewProtection({
      edit,
      protection: overlay.projection.spec.protection,
      point,
      instrument,
      reference:
        edit.kind === "order"
          ? undefined
          : positionProtectionReference(
              edit.order as Position | IndividualPosition,
              host.session.state.quotes.get(edit.order.symbol),
            ),
      profitText: (side, qty, entry, exit) =>
        host.exitText(
          edit.order.symbol,
          side,
          qty,
          entry,
          exit,
          overlay.moneyAccount ?? host.currentProfitAccount(),
        ),
    });
    if (!protection) return;
    overlay.proposedProtection =
      host.lockFor(owner, overlay.projection)?.reviewedKey === overlay.projection.spec.key
        ? { ...protection, phase: "pending" }
        : protection;
    host.updateOverlay(overlay.handle, {
      protection: host.shownProtection(owner, overlay.projection, overlay.proposedProtection),
    });
  }

  /** Returns an overlay to its broker projection, dropping any proposed price or protection. */
  function restoreProjection(owner: Owner, overlay: Overlay): void {
    overlay.proposedProtection = undefined;
    host.updateOverlay(overlay.handle, {
      price: overlay.projection.spec.price,
      protection: host.shownProtection(owner, overlay.projection),
    });
  }
  /** Ends the overlay's gesture state, its proposal and finance lease; does not touch the chart gesture. */
  function endGesture(owner: Owner, overlay: Overlay): void {
    overlay.parentEdit = undefined;
    overlay.previewEvent = undefined;
    overlay.gestureId = undefined;
    overlay.gestureLeg = undefined;
    overlay.gestureRevision = undefined;
    host.session.chartEdits.clearIf(overlay.editToken);
    overlay.releaseFinance?.();
    overlay.releaseFinance = undefined;
    restoreProjection(owner, overlay);
  }
  function cancelGesture(owner: Owner, overlay: Overlay): void {
    if (!overlay.gestureId) return;
    overlay.proposedProtection = undefined;
    // Cleared first so the dragCancel echoed by cancelInteraction is ignored.
    overlay.gestureId = undefined;
    try {
      overlay.handle.cancelInteraction();
    } finally {
      endGesture(owner, overlay);
    }
  }
  /** Event handler for one overlay; `isCurrent` says whether the overlay still belongs to its live owner. */
  function handler(owner: Owner, overlay: Overlay, key: string, isCurrent: () => boolean) {
    const handle = overlay.handle;
    const entityId = overlay.projection.id,
      entityKind = overlay.projection.kind;
    return function handleOverlayEvent(input: TradingOverlayEvent): void {
      if (!isCurrent()) return;
      let event: TradingOverlayEvent;
      try {
        event = normalizeOverlayEvent(input);
      } catch (cause) {
        host.safely(() => cancelGesture(owner, overlay));
        host.onError(cause);
        return;
      }
      if (event.type === "dragStart") {
        if (reviewLineLocked(key, host.lockFor(owner, overlay.projection))) {
          handle.cancelInteraction();
          return;
        }
        if (event.leg) {
          if (!overlay.projection.spec.protection?.handles.includes(event.leg) || entityKind === "execution") return;
          try {
            host.session.chartEdits.begin(entityId, entityKind, owner.binding, {
              leg: event.leg,
              multiple: host.multipleExitLevels(owner.binding.symbol),
              completed: host.completedParent(entityKind, entityId),
            });
          } catch (cause) {
            handle.cancelInteraction();
            host.onError(cause);
            return;
          }
          overlay.releaseFinance?.();
          if (host.pipFinanceNeeded(owner.binding.symbol))
            host.safely(() => {
              overlay.releaseFinance = host.session.acquireFinancial("pip", owner.binding.symbol);
            });
        } else {
          if (!overlay.projection.spec.actions.includes("modify")) return;
          overlay.parentEdit = undefined;
          try {
            const parentEdit = host.confirmedExitParent(overlay, entityKind, entityId);
            if (parentEdit) {
              // The dragged exit shows the edit, so its display key must be known before `begin` notifies.
              host.displayOn(key, () =>
                host.session.chartEdits.begin(parentEdit.id, parentEdit.kind, owner.binding, {
                  leg: parentEdit.leg,
                  level: parentEdit.level,
                  completed: parentEdit.completed,
                }),
              );
              overlay.parentEdit = {
                kind: parentEdit.kind,
                id: parentEdit.id,
                leg: parentEdit.leg,
                level: parentEdit.level,
              };
            } else if (entityKind === "order") host.session.chartEdits.begin(entityId, entityKind, owner.binding);
          } catch (cause) {
            handle.cancelInteraction();
            host.onError(cause);
            return;
          }
        }
        overlay.moneyAccount = host.currentProfitAccount();
        overlay.editToken = host.session.chartEdits.state.get()?.token;
        overlay.gestureRevision = overlay.projection.revision;
        overlay.gestureId = event.gestureId;
        overlay.gestureLeg = event.leg;
        return;
      }
      if (event.type === "dragPreview") {
        if (event.gestureId !== overlay.gestureId) return;
        overlay.previewEvent = event;
        // A parent edit previews the dragged leg from the parent's entry, not as a standalone exit order.
        const point = overlay.parentEdit ? { price: event.price, leg: overlay.parentEdit.leg } : event;
        updateProtectionPreview(owner, overlay, point, event.gestureId);
        return;
      }
      if ((event.type === "dragCommit" || event.type === "dragCancel") && event.gestureId !== overlay.gestureId) return;
      if (event.type === "dragCancel") {
        endGesture(owner, overlay);
        return;
      }
      if (event.type === "dragCommit") {
        if (!gestureEligible(overlay.projection, event.leg)) {
          // The chart gesture has finished; restore the broker presentation and release the gesture.
          endGesture(owner, overlay);
          return;
        }
      } else if (
        !overlay.projection.spec.actions.includes(event.type) ||
        (event.type === "modify" && reviewLineLocked(key, host.lockFor(owner, overlay.projection)))
      )
        return;
      const parentEdit = event.type === "dragCommit" ? overlay.parentEdit : undefined;
      const parentContext = parentEdit ? host.session.chartEdits.state.get()?.context.revision : undefined;
      const revision =
        event.type === "dragCommit"
          ? (parentContext ?? overlay.gestureRevision ?? overlay.projection.revision)
          : overlay.projection.revision;
      if (event.type === "dragCommit") {
        overlay.parentEdit = undefined;
        overlay.gestureRevision = undefined;
        overlay.previewEvent = undefined;
        overlay.gestureId = undefined;
        overlay.gestureLeg = undefined;
      }
      const editToken = event.type === "dragCommit" ? overlay.editToken : undefined;
      const lease = event.type === "dragCommit" ? overlay.releaseFinance : undefined;
      const releaseFinance = lease && overlay.scope.own(lease);
      if (lease) overlay.releaseFinance = undefined;
      const restore = () => {
        releaseFinance?.();
        if (editToken === undefined || overlay.editToken !== editToken || overlay.gestureId) return;
        const current = host.session.chartEdits.state.get();
        if (current?.token === editToken && current.phase === "dragging") host.session.chartEdits.clearIf(editToken);
        if (isCurrent() && host.session.chartEdits.state.get()?.token !== editToken) restoreProjection(owner, overlay);
      };
      const failed = (cause: unknown) => {
        host.session.chartEdits.clearIf(editToken);
        host.onError(cause);
      };
      try {
        const edit = host.session.chartEdits.state.get();
        // Release the chart before allocated exit validation can await broker metadata.
        if (event.type === "dragCommit" && edit?.leg && edit.token === editToken)
          host.releaseEdit(edit, { leg: edit.leg, price: event.price });
        void Promise.resolve(
          host.onAction({
            binding: owner.binding,
            entityId: parentEdit?.id ?? entityId,
            kind: parentEdit?.kind ?? entityKind,
            revision,
            event: parentEdit && event.type === "dragCommit" ? { ...event, leg: parentEdit.leg } : event,
          }),
        )
          .catch(failed)
          .finally(restore);
      } catch (cause) {
        failed(cause);
        restore();
      }
    };
  }
  return { gestureEligible, updateProtectionPreview, restoreProjection, endGesture, cancelGesture, handler };
}
