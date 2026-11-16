import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { createPointerDrag } from "../pointer-drag.js";
import { TradingButton } from "../primitives.js";
import { TicketLayoutContext } from "./layout-context.js";
const directions: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
export function TicketMoveHandle(props: {
  symbol: string;
  description?: string;
}) {
  const layout = useContext(TicketLayoutContext);
  const help = createUniqueId();
  const [dragging, setDragging] = createSignal(false);
  const drag = createPointerDrag({
    disabled: () => !layout?.canMove(),
    capture: () => ({
      rendered: layout!.state().bounds,
      requested: layout!.placement.captureBounds(),
    }),
    preview: (origin, delta) =>
      layout!.placement.previewPosition(
        origin.rendered.x + delta.x,
        origin.rendered.y + delta.y,
      ),
    commit: () => layout!.placement.save(),
    cancel: (origin) => {
      layout!.placement.restoreBounds(origin.requested);
    },
    activeChanged: setDragging,
  });
  createEffect(() => {
    if (!layout?.canMove()) drag.cancel();
  });
  onCleanup(drag.destroy);
  return (
    <Show
      when={layout?.state().floating}
      fallback={<strong title={props.description}>{props.symbol}</strong>}
    >
      <TradingButton
        class="trading-ticket-move"
        data-ui="trading-ticket-move"
        disabled={!layout?.canMove()}
        title={props.description}
        aria-label={`Move ${props.symbol} order ticket`}
        aria-describedby={help}
        data-dragging={dragging()}
        onPointerDown={(event) => drag.begin(event, event.currentTarget)}
        onClick={(event) => {
          if (event.detail === 0 && !drag.active() && layout?.canMove())
            layout.placement.center();
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if (drag.active()) {
            if (
              directions[event.key] ||
              ["Home", "Enter", " "].includes(event.key)
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            event.stopPropagation();
            layout!.placement.center();
            return;
          }
          const direction = directions[event.key];
          if (!direction) return;
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 50 : 10,
            bounds = layout!.state().bounds;
          if (
            layout!.placement.previewPosition(
              bounds.x + direction[0] * step,
              bounds.y + direction[1] * step,
            )
          )
            layout!.placement.save();
        }}
      >
        <strong>{props.symbol}</strong>
      </TradingButton>
      <span id={help} class="trading-visually-hidden">
        Use arrow keys to move. Activate or press Home to center the ticket.
      </span>
    </Show>
  );
}
