import { sameBinding } from "../../core/identity.js";
import { COMPACT_WIDTH } from "../layout.js";
import type { DockSizes } from "../dock-sizes.js";
import { ResizeHandle } from "../resize-handle.js";
import { useTradingValue } from "../primitives.js";
import { bindSurfaceTheme } from "../surface-theme.js";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type {
  TradingChartPort,
  TradingCollectionPort,
  TradingPresentationPort,
} from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { DisposalScope } from "../../core/disposal.js";
import { createDomController } from "./controller.js";
import type { DomController } from "./controller.js";
import { DepthPanelView } from "./view.js";
/** Only a visible depth panel owns market subscriptions and its captured command context. */
export function createDomWorkspace(options: {
  sizes: DockSizes;
  session: TradingSession;
  collection: TradingCollectionPort;
  presentation: TradingPresentationPort;
  compactTicket(chart: TradingChartPort, qty?: number): void;
  visibility(visible: boolean): void;
}) {
  const scope = new DisposalScope();
  const [selected, setSelected] = createSignal<DomController>();
  let currentChart: TradingChartPort | undefined,
    visible = false,
    disposed = false;
  let element: HTMLElement | undefined;
  function hide(): void {
    if (!visible && !selected()) return;
    visible = false;
    selected()?.destroy();
    setSelected(undefined);
    currentChart = undefined;
    if (element) element.hidden = true;
    options.presentation.setDockSize("dom", 0);
    options.visibility(false);
  }
  scope.own(
    options.session.state.connection.subscribe((connection) => {
      if (connection.phase !== "ready") hide();
    }),
  );
  scope.own(
    options.collection.subscribe((event) => {
      if (event.type !== "removed" && event.type !== "bindingChanged") return;
      const binding = event.type === "removed" ? event.binding : event.previous,
        captured = selected()?.binding;
      if (
        sameBinding(captured, binding)
      )
        hide();
    }),
  );
  scope.own(
    options.presentation.environment.subscribe((environment) => {
      if (visible && environment.width < COMPACT_WIDTH && currentChart) {
        const chart = currentChart;
        const state = selected()?.state.get();
        const quantity = state?.phase === "ready" ? state.qty : undefined;
        hide();
        options.compactTicket(chart, quantity);
      }
    }),
  );
  scope.own(
    options.sizes.right.subscribe((width) => {
      if (visible) options.presentation.setDockSize("dom", width);
    }),
  );
  function DomWidthHandle() {
    const width = useTradingValue(options.sizes.right);
    return (
      <ResizeHandle
        class="trading-dock-resizer"
        axis="width"
        label="Resize depth panel"
        disabled={!selected()}
        value={width()}
        min={280}
        max={480}
        resize={(value) => options.sizes.resize("right", value)}
        save={() => options.sizes.save("right")}
      />
    );
  }
  return {
    isVisible: () => visible,
    open(chart: TradingChartPort): void {
      if (
        disposed ||
        !options.session.features.dom_widget ||
        !options.session.symbolPolicy(chart.binding.get().symbol).dom
      )
        return;
      if (options.presentation.environment.get().width < COMPACT_WIDTH) {
        options.compactTicket(chart, selected()?.state.get().qty);
        return;
      }
      if (!element) {
        const surface = options.presentation.acquireSurface("dom");
        element = surface.element;
        element.classList.add("lumen-trading");
        scope.own(surface.release);
        scope.own(bindSurfaceTheme(element, options.presentation.environment));
        scope.own(
          render(
            () => (
              <>
                <DomWidthHandle />
                <Show when={selected()} keyed>
                  {(controller) => (
                    <DepthPanelView
                      controller={controller}
                      session={options.session}
                      locale={options.presentation.environment.get().locale}
                      onClose={hide}
                    />
                  )}
                </Show>
              </>
            ),
            element,
          ),
        );
      }
      if (currentChart !== chart) {
        selected()?.destroy();
        currentChart = chart;
        setSelected(createDomController(options.session, chart));
      }
      visible = true;
      element.hidden = false;
      options.visibility(true);
      options.presentation.setDockSize("dom", options.sizes.right.get());
    },
    hide,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      hide();
      scope.destroy();
    },
  };
}
