interface PointerDelta {
  readonly x: number;
  readonly y: number;
}
interface PointerDragOptions<T> {
  disabled(): boolean;
  capture(): T;
  preview(origin: T, delta: PointerDelta): void | boolean;
  commit(origin: T): void;
  cancel(origin: T): void;
  activeChanged?(active: boolean): void;
}
/** One scoped pointer owner covers release, cancellation, missed release and removal without layout reads. */
export function createPointerDrag<T>(options: PointerDragOptions<T>) {
  let disposed = false;
  let gesture:
    | { id: number; x: number; y: number; origin: T; element: HTMLElement }
    | undefined;
  function detach(element: HTMLElement): void {
    const document = element.ownerDocument;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancelPointer);
    document.removeEventListener("keydown", escape, true);
    document.removeEventListener("visibilitychange", visibility);
    document.defaultView?.removeEventListener("blur", blur);
    element.removeEventListener("lostpointercapture", cancelPointer);
  }
  function finish(commit: boolean): void {
    const ending = gesture;
    if (!ending) return;
    gesture = undefined;
    detach(ending.element);
    try {
      if (ending.element.hasPointerCapture?.(ending.id))
        ending.element.releasePointerCapture(ending.id);
    } catch {
      /* The browser may already have released capture during removal. */
    }
    options.activeChanged?.(false);
    if (commit) options.commit(ending.origin);
    else options.cancel(ending.origin);
  }
  function move(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (event.buttons === 0) {
      finish(false);
      return;
    }
    const active = gesture;
    if (
      options.preview(active.origin, {
        x: event.clientX - active.x,
        y: event.clientY - active.y,
      }) === false
    )
      finish(false);
    event.preventDefault();
  }
  function up(event: PointerEvent): void {
    if (event.pointerId === gesture?.id) finish(true);
  }
  function cancelPointer(event: PointerEvent): void {
    if (event.pointerId === gesture?.id) finish(false);
  }
  const blur = () => finish(false);
  const visibility = () => {
    if (gesture?.element.ownerDocument.hidden) finish(false);
  };
  function escape(event: KeyboardEvent): void {
    if (!gesture || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  }
  return {
    active: () => gesture !== undefined,
    begin(event: PointerEvent, element: HTMLElement): boolean {
      if (
        disposed ||
        options.disabled() ||
        gesture ||
        event.button !== 0 ||
        !event.isPrimary ||
        !element.isConnected
      )
        return false;
      event.preventDefault();
      event.stopPropagation();
      element.focus({ preventScroll: true });
      if (disposed || options.disabled() || !element.isConnected) return false;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        origin: options.capture(),
        element,
      };
      const document = element.ownerDocument;
      document.addEventListener("pointermove", move, { passive: false });
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancelPointer);
      document.addEventListener("keydown", escape, true);
      document.addEventListener("visibilitychange", visibility);
      document.defaultView?.addEventListener("blur", blur);
      element.addEventListener("lostpointercapture", cancelPointer);
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {
        finish(false);
        return false;
      }
      options.activeChanged?.(true);
      return gesture !== undefined;
    },
    cancel: () => finish(false),
    destroy(): void {
      if (disposed) return;
      disposed = true;
      finish(false);
    },
  };
}
