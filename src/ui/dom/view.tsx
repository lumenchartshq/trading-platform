import { userMessage } from "../../core/errors.js";
import { symbolLabel } from "../../core/features.js";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { OrderType, Side } from "../../contracts/broker.js";
import type { TradingSession } from "../../core/session.js";
import type { DomController } from "./controller.js";
import { TradingButton, NumberField, useTradingValue } from "../primitives.js";
import { formatDepthVolume } from "./ladder.js";
function DepthRow(props: {
  controller: DomController;
  session: TradingSession;
  index: number;
  disabled: () => boolean;
  locale: string;
  report: (work: Promise<unknown>) => void;
}) {
  const ladder = props.controller.ladder!,
    row = useTradingValue(ladder.row(props.index)!);
  const leases = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function hold(button: HTMLButtonElement, keyboard = false): void {
    const target = ladder.beginAction(props.index),
      document = button.ownerDocument;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      target.release();
      leases.delete(release);
      document.removeEventListener("pointerup", ended, true);
      document.removeEventListener("pointercancel", release, true);
      button.removeEventListener("keyup", ended);
      button.removeEventListener("blur", release);
      document.defaultView?.removeEventListener("blur", release);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };
    const ended = () => {
      if (timer !== undefined) return;
      timer = setTimeout(release, 0);
      timers.add(timer);
    };
    leases.add(release);
    button.addEventListener("blur", release, { once: true });
    document.defaultView?.addEventListener("blur", release, { once: true });
    if (keyboard) button.addEventListener("keyup", ended, { once: true });
    else {
      document.addEventListener("pointerup", ended, {
        once: true,
        capture: true,
      });
      document.addEventListener("pointercancel", release, {
        once: true,
        capture: true,
      });
    }
  }
  onCleanup(() => {
    for (const release of leases) release();
    for (const timer of timers) clearTimeout(timer);
  });
  const volume = (value: number) =>
    value === 0
      ? ""
      : formatDepthVolume(
          value,
          props.session.features.dom_raw_volume_values,
          props.locale,
        );
  const action = (side: Side) => (
    <TradingButton
      disabled={props.disabled()}
      data-depth-side={side}
      data-depth-index={props.index}
      aria-label={`${side === Side.Buy ? "Buy" : "Sell"} limit at ${row().price}`}
      onPointerDown={(event) => {
        if (event.button === 0 && !props.disabled()) hold(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          !event.repeat &&
          !props.disabled()
        ) {
          hold(event.currentTarget, true);
        }
      }}
      onClick={() => props.report(props.controller.order(side, props.index))}
    >
      {side === Side.Buy ? volume(row().bid) : volume(row().ask)}
      <Show
        when={(side === Side.Buy ? row().buyQuantity : row().sellQuantity) > 0}
      >
        <small>
          {" "}
          · {side === Side.Buy ? row().buyQuantity : row().sellQuantity} own
        </small>
      </Show>
    </TradingButton>
  );
  return (
    <tr data-depth-price={row().price}>
      <td>{action(Side.Buy)}</td>
      <th scope="row">{row().price}</th>
      <td>{action(Side.Sell)}</td>
    </tr>
  );
}
export function DepthPanelView(props: {
  controller: DomController;
  session: TradingSession;
  locale: string;
  onClose(): void;
}) {
  const state = useTradingValue(props.controller.state),
    policy = useTradingValue(props.session.policy),
    symbolOptions = useTradingValue(props.session.symbolOptionsRevision),
    connection = useTradingValue(props.session.state.connection);
  const [actionError, setActionError] = createSignal<string>();
  const report = (work: Promise<unknown>) => {
    setActionError(undefined);
    void work.catch((cause) =>
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The action could not be completed.",
      ),
    );
  };
  const disabled = () =>
    state().phase !== "ready" ||
    state().pending ||
    connection().phase !== "ready" ||
    !policy().dom;
  const [positionRevision, setPositionRevision] = createSignal(0);
  const releasePositions = props.session.state.positions.subscribeChanges(() =>
    setPositionRevision((value) => value + 1),
  );
  onCleanup(releasePositions);
  const positions = createMemo(() => {
    positionRevision();
    return props.session.state.positions
      .ids()
      .map((id) => props.session.state.positions.get(id)!)
      .filter(
        (position) => position.symbol === props.controller.binding.symbol,
      );
  });
  return (
    <section data-ui="trading-dom" aria-label="Market depth">
      <header class="trading-panel-header">
        <strong>
          Market depth ·{" "}
          {symbolLabel(props.controller.binding.symbol, props.session.features)}
        </strong>
        <TradingButton onClick={props.onClose}>Close</TradingButton>
      </header>
      <Show when={state().phase === "loading"}>
        <p role="status">Loading market depth…</p>
      </Show>
      <Show when={state().error || actionError()}>
        <p role="alert">{state().error || actionError()}</p>
      </Show>
      <NumberField
        label="Quantity"
        value={state().qty}
        disabled={disabled()}
        onChange={(value) => {
          try {
            props.controller.quantity(value ?? NaN);
            setActionError(undefined);
          } catch (cause) {
            setActionError(
              userMessage(cause, "Check the quantity."),
            );
          }
        }}
      />
      <div class="trading-dom-actions">
        <TradingButton
          tone="buy"
          disabled={
            disabled() || !policy().orderTypes.includes(OrderType.Market)
          }
          onClick={() => report(props.controller.order(Side.Buy))}
        >
          Buy market
        </TradingButton>
        <TradingButton
          tone="sell"
          disabled={
            disabled() || !policy().orderTypes.includes(OrderType.Market)
          }
          onClick={() => report(props.controller.order(Side.Sell))}
        >
          Sell market
        </TradingButton>
        <TradingButton
          disabled={disabled()}
          onClick={() => props.controller.ladder?.recenter()}
        >
          Recenter
        </TradingButton>
      </div>
      <Show when={state().phase === "ready"}>
        {(_) => {
          const keys = useTradingValue(props.controller.ladder!.viewport);
          return (
            <table
              class="trading-dom-ladder"
              aria-label="Depth price ladder"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  return;
                const target = event.target as HTMLElement;
                if (!target.dataset.depthSide) return;
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    `button[data-depth-side="${target.dataset.depthSide}"]`,
                  ),
                ];
                const offset = event.key === "ArrowDown" ? 1 : -1,
                  next =
                    buttons[
                      buttons.indexOf(target as HTMLButtonElement) + offset
                    ];
                if (next) {
                  event.preventDefault();
                  next.focus();
                }
              }}
            >
              <thead>
                <tr>
                  <th>Buy / bid size</th>
                  <th>Price</th>
                  <th>Sell / ask size</th>
                </tr>
              </thead>
              <tbody>
                <For each={keys()}>
                  {(index) => (
                    <DepthRow
                      controller={props.controller}
                      session={props.session}
                      index={index}
                      locale={props.locale}
                      disabled={() =>
                        disabled() ||
                        !policy().orderTypes.includes(OrderType.Limit)
                      }
                      report={report}
                    />
                  )}
                </For>
              </tbody>
            </table>
          );
        }}
      </Show>
      <div class="trading-dom-actions">
        <TradingButton
          disabled={disabled()}
          onClick={() => report(props.controller.cancel(Side.Buy))}
        >
          Cancel buys
        </TradingButton>
        <TradingButton
          disabled={disabled()}
          onClick={() => report(props.controller.cancel(Side.Sell))}
        >
          Cancel sells
        </TradingButton>
        <TradingButton
          disabled={disabled()}
          onClick={() => report(props.controller.cancel())}
        >
          Cancel all
        </TradingButton>
      </div>
      <Show
        when={
          policy() &&
          symbolOptions() >= 0 &&
          props.session.symbolPolicy(props.controller.binding.symbol).flags
            .supportReversePosition
        }
      >
        <For each={positions()}>
          {(position) => (
            <TradingButton
              disabled={disabled()}
              onClick={() => report(props.controller.reverse(position.id))}
            >
              Reverse {position.id}
            </TradingButton>
          )}
        </For>
      </Show>
    </section>
  );
}
