import { createEffect, createSignal, onCleanup } from "solid-js";
import { createPointerDrag } from "./pointer-drag.js";

/**
 * The one resize handle for terminal and trading panels. Placement belongs to the host (`class`);
 * the hit area, accent line and focus rules come from `resize-handle.css`, so every handle looks
 * and behaves the same. One owner handles completion, lost release, cancellation and removal,
 * with no layout reads on moves.
 */
export function ResizeHandle(props: {
  /** `width` resizes a panel on the handle's far side horizontally; `height` vertically. */
  axis: "width" | "height";
  /** Host placement class, for example a dock edge or a flex gap. */
  class?: string;
  label: string;
  value: number;
  capture?(): number;
  min: number;
  max: number;
  disabled?: boolean;
  resize(pixels: number): void;
  save(): void;
}) {
  const bound = (value: number) =>
    Math.round(Math.min(props.max, Math.max(props.min, value)));
  // A signal, so the dragging state clears on release, cancel and lost capture alike.
  const [dragging, setDragging] = createSignal(false);
  const drag = createPointerDrag({
    activeChanged: setDragging,
    disabled: () => props.disabled === true,
    capture: () => ({
      size: props.value,
      restore: props.capture?.() ?? props.value,
    }),
    preview: (origin, delta) =>
      props.resize(
        bound(origin.size - (props.axis === "width" ? delta.x : delta.y)),
      ),
    commit: () => props.save(),
    cancel: (origin) => props.resize(origin.restore),
  });
  createEffect(() => {
    if (props.disabled) drag.cancel();
  });
  onCleanup(drag.destroy);
  return (
    <div
      class={props.class ? `lumen-resize-handle ${props.class}` : "lumen-resize-handle"}
      data-axis={props.axis}
      data-state={dragging() ? "dragging" : undefined}
      role="separator"
      aria-label={props.label}
      aria-orientation={props.axis === "width" ? "vertical" : "horizontal"}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={bound(props.value)}
      aria-disabled={props.disabled === true}
      tabIndex={props.disabled ? -1 : 0}
      hidden={props.disabled}
      onPointerDown={(event) => {
        // The drag focuses the handle so arrow keys keep working; that focus came from the
        // pointer, so it must not show the keyboard focus line after release.
        event.currentTarget.dataset.focusSource = "pointer";
        drag.begin(event, event.currentTarget);
      }}
      onBlur={(event) => delete event.currentTarget.dataset.focusSource}
      onKeyDown={(event) => {
        delete event.currentTarget.dataset.focusSource;
        if (props.disabled || drag.active()) return;
        const grow = props.axis === "width" ? "ArrowLeft" : "ArrowUp";
        const shrink = props.axis === "width" ? "ArrowRight" : "ArrowDown";
        let value: number;
        if (event.key === "Home") value = props.min;
        else if (event.key === "End") value = props.max;
        else if (event.key === grow)
          value = props.value + (event.shiftKey ? 50 : 10);
        else if (event.key === shrink)
          value = props.value - (event.shiftKey ? 50 : 10);
        else return;
        event.preventDefault();
        event.stopPropagation();
        props.resize(bound(value));
        props.save();
      }}
    />
  );
}
