import { Toast, toaster } from "@kobalte/core/toast";
import { createUniqueId, onCleanup, Show } from "solid-js";
import { NotificationType, Side } from "../../contracts/broker.js";
import { OrderNotice } from "../../core/order-notifications.js";
import { sideName } from "../../core/order-labels.js";
import { showsToast } from "../../core/trading-settings.js";
import type { TradingNotification } from "../../core/notification-log.js";
import type { TradingSession } from "../../core/session.js";
import { CloseIcon } from "../icons.js";
import { useTradingValue } from "../primitives.js";
import { SymbolLogo } from "../symbol-logo.js";
import { createSymbolLabel } from "../symbol-label.js";

const visibleFor = 6000;
const visibleLimit = 3;
const immediateFillMs = 1200;

function toastTone(item: TradingNotification) {
  if (item.type === NotificationType.Error) return "error";
  if (item.event === OrderNotice.Placed && item.trade)
    return item.trade.side === Side.Buy ? "buy" : "sell";
  if (item.event === OrderNotice.Cancelled) return "neutral";
  return "success";
}

const glyphs = {
  buy: "m5 14 7-6 7 6",
  sell: "m5 10 7 6 7-6",
  error: "M12 6v7m0 4h.01",
  success: "m6 12 4 4 8-8",
  neutral: "M6 12h12",
};

/** Kobalte's toaster is page-wide, so each mount dismisses only its own entries. */
/** The notification's symbol as the platform's panels name it: the broker's display symbol once the instrument is known. */
function ToastSymbol(props: { session: TradingSession; symbol: string }) {
  const label = createSymbolLabel(props.session, () => props.symbol);
  return <span class="trading-toast-symbol"><SymbolLogo symbol={props.symbol} enabled />{label()}</span>;
}

export function TradingToasts(props: { session: TradingSession }) {
  const region = `trading-toasts-${createUniqueId()}`;
  const shown = new Map<number, { item: TradingNotification; shownAt: number }>();
  let lastSeen = props.session.notifications.get().at(-1)?.id ?? 0;

  const dismiss = (id: number) => {
    shown.delete(id);
    toaster.dismiss(id);
  };
  useTradingValue(props.session.notifications, (_previous, next) => {
    for (const item of next) {
      if (item.id <= lastSeen) continue;
      lastSeen = item.id;
      if (item.audience === "history" || !showsToast(item.type, props.session.displaySettings.get())) continue;
      const shownAt = performance.now();
      if (item.market && item.orderId && item.event === OrderNotice.Executed) {
        for (const [id, { item: earlier, shownAt: placedAt }] of shown) {
          if (earlier.orderId === item.orderId && earlier.accountGeneration === item.accountGeneration &&
            earlier.event === OrderNotice.Placed && shownAt - placedAt <= immediateFillMs) dismiss(id);
        }
      }
      const tone = toastTone(item);
      const id = toaster.show((toast) => {
        onCleanup(() => shown.delete(toast.toastId));
        return (
          <Toast
            toastId={toast.toastId}
            class="trading-toast"
            data-tone={tone}
            priority={tone === "error" ? "high" : "low"}
            onEscapeKeyDown={() => dismiss(toast.toastId)}
          >
            <div class="trading-toast-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d={glyphs[tone]} /></svg>
            </div>
            <div class="trading-toast-message">
              <Toast.Title as="strong">
                {item.title}
                <Show when={item.symbol}>
                  {(symbol) => <> on <ToastSymbol session={props.session} symbol={symbol()} /></>}
                </Show>
              </Toast.Title>
              <Toast.Description as="div" class="trading-toast-detail">
                <Show when={item.trade} fallback={item.text}>
                  {(trade) => (
                    <>
                      <span class="trading-toast-side" data-side={trade().side === Side.Buy ? "buy" : "sell"}>
                        {sideName(trade().side)} {trade().quantity}
                      </span>{" "}{trade().detail}
                    </>
                  )}
                </Show>
              </Toast.Description>
            </div>
            <Toast.CloseButton
              class="trading-button trading-icon-button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.toastId)}
            >
              <CloseIcon inset={6} />
            </Toast.CloseButton>
          </Toast>
        );
      }, { region });
      shown.set(id, { item, shownAt });
      const oldest = shown.keys().next().value;
      if (shown.size > visibleLimit && oldest !== undefined) dismiss(oldest);
    }
  });
  onCleanup(() => {
    for (const id of shown.keys()) toaster.dismiss(id);
    shown.clear();
  });
  return (
    <Toast.Region
      regionId={region}
      class="trading-toasts"
      aria-label="Trading notifications ({hotkey})"
      hotkey={["F8"]}
      duration={visibleFor}
      limit={visibleLimit}
      style={{ "pointer-events": "none" }}
    >
      <Toast.List class="trading-toast-list" />
    </Toast.Region>
  );
}
