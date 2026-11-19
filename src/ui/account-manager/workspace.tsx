import { accountDockHeight, dockFixed, dockResizable } from "../layout.js";
import { useWatchedValue } from "../primitives.js";
import type { DockSizes } from "../dock-sizes.js";
import { ResizeHandle } from "../resize-handle.js";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { BottomWidgetBarMode } from "../../contracts/broker.js";
import type {
  TradingChartBinding,
  TradingCollectionPort,
  TradingPresentationPort,
} from "../../contracts/ports.js";
import type { TradingSession } from "../../core/session.js";
import { useTradingValue } from "../primitives.js";
import type { PositionRowAction } from "./row-actions.js";
import { AccountManagerView } from "./view.js";
/** Keeps the bottom rail mounted while its account pages are collapsed. */
export function AccountManagerWorkspace(props: {
  sizes: DockSizes;
  session: TradingSession;
  presentation: TradingPresentationPort;
  collection: TradingCollectionPort;
  onTrade(binding: TradingChartBinding, initiator: HTMLElement): void;
  onDepth(): void;
  onOrderAction(id: string): void;
  onPositionAction(
    id: string,
    individual: boolean,
    action: PositionRowAction,
  ): Promise<void>;
}) {
  const manager = props.session.host.getAccountManagerVisibilityMode();
  const requestedMode = useWatchedValue(manager);
  // A fixed host box shows the tables at its own size: the panel stays normal whatever mode is saved or requested.
  const fixed = dockFixed(props.presentation, "accounts");
  const mode = () => (fixed ? BottomWidgetBarMode.Normal : requestedMode());
  const environment = useTradingValue(props.presentation.environment);
  const [active, setActive] = createSignal(
    props.collection.activeChart()?.binding.get(),
  );
  const updateActive = () =>
    setActive(props.collection.activeChart()?.binding.get());
  onCleanup(props.collection.subscribe(updateActive));
  const height = useTradingValue(props.sizes.accounts);
  const bounds = (maximized = false) => {
    const height = environment().height;
    return (
      props.presentation.dockBounds?.("accounts", { maximized }) ?? {
        min: 160,
        max: Math.max(160, height - 100),
      }
    );
  };
  const maximumHeight = () => bounds().max;
  const normalHeight = (preferred = height()) => accountDockHeight(preferred, environment().width, maximumHeight());
  createEffect(() => {
    let size = normalHeight();
    if (mode() === BottomWidgetBarMode.Minimized) size = 36;
    else if (mode() === BottomWidgetBarMode.Maximized) size = bounds(true).max;
    props.presentation.setDockSize("accounts", size, {
      maximized: mode() === BottomWidgetBarMode.Maximized,
      collapsed: mode() === BottomWidgetBarMode.Minimized,
    });
  });
  onCleanup(() => props.presentation.setDockSize("accounts", 0));
  const set = (value: BottomWidgetBarMode) =>
    props.session.host.setAccountManagerVisibilityMode(value);
  return (
    <div class="trading-account-workspace">
      <Show when={dockResizable(props.presentation, "accounts")}>
        <ResizeHandle
          class="trading-dock-resizer"
          axis="height"
          label="Resize Account Manager"
          value={normalHeight()}
          capture={height}
          min={normalHeight(bounds().min)}
          max={maximumHeight()}
          disabled={mode() !== BottomWidgetBarMode.Normal}
          resize={(value) => props.sizes.resize("accounts", value)}
          save={() => props.sizes.save("accounts")}
        />
      </Show>
      <AccountManagerView
        session={props.session}
        environment={environment()}
        collapsed={mode() === BottomWidgetBarMode.Minimized}
        maximized={mode() === BottomWidgetBarMode.Maximized}
        fixed={fixed}
        onClose={fixed ? undefined : () => set(BottomWidgetBarMode.Minimized)}
        onToggle={() =>
          set(
            mode() === BottomWidgetBarMode.Minimized
              ? BottomWidgetBarMode.Normal
              : BottomWidgetBarMode.Minimized,
          )
        }
        onMaximize={() =>
          set(
            mode() === BottomWidgetBarMode.Maximized
              ? BottomWidgetBarMode.Normal
              : BottomWidgetBarMode.Maximized,
          )
        }
        canTrade={active() !== undefined}
        onTrade={(initiator) => {
          const binding = active();
          if (binding) props.onTrade(binding, initiator);
        }}
        onDepth={props.onDepth}
        onOrderAction={props.onOrderAction}
        onPositionAction={props.onPositionAction}
      />
    </div>
  );
}
