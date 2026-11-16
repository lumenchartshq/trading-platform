import { createMemo, For, Show } from "solid-js";
import type { TradingEnvironment } from "../../contracts/ports.js";
import type { TradingNotification } from "../../core/notification-log.js";
import { SymbolLogo } from "../symbol-logo.js";

export function TradingNotificationLog(props: {
  entries: readonly TradingNotification[];
  environment: TradingEnvironment;
}) {
  const rows = createMemo(() => props.entries.filter(item => item.audience !== "toast")
    .sort((a, b) => b.time - a.time || b.id - a.id));
  const clock = createMemo(() => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium", hourCycle: "h23" };
    try {
      return new Intl.DateTimeFormat(props.environment.locale, { ...options, timeZone: props.environment.timezone });
    } catch {
      return new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
    }
  });
  return (
    <Show when={rows().length} fallback={<p class="trading-notification-empty">There are no notifications yet.</p>}>
      <div class="trading-notification-scroll" role="region" aria-label="Notifications log" tabindex="0">
        <table class="trading-table trading-notifications">
          <thead>
            <tr>
              <th scope="col">Symbol</th>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Details</th>
              <th scope="col">Order ID</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(item) => (
                <tr data-row-id={item.id}>
                  <td>
                    <Show when={item.symbol} fallback="—">
                      {(symbol) => <><SymbolLogo symbol={symbol()} enabled />{symbol()}</>}
                    </Show>
                  </td>
                  <td><time datetime={new Date(item.time).toISOString()}>{clock().format(item.time)}</time></td>
                  <td>{item.title}</td>
                  <td>{item.text}</td>
                  <td>{item.orderId ?? "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
