import { TicketLayoutContext } from "./layout-context.js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { createSignal, onCleanup, Show, useContext } from "solid-js";
import type { OrderTicketSettings } from "../../contracts/broker.js";
import type { TradingSession } from "../../core/session.js";
import { useTradingValue } from "../primitives.js";
import { TradingPopupMount } from "../popup-mount.js";

/** Ticket display controls stay in the header menu; chart preferences have their own dialog. */
export function OrderTicketMenu(props: {
  session: TradingSession;
  previewAvailable: boolean;
}) {
  let trigger!: HTMLButtonElement;
  let openProperties = false;
  let alive = true;
  onCleanup(() => {
    openProperties = false;
    alive = false;
  });
  const popupMount = useContext(TradingPopupMount);
  const layout = useContext(TicketLayoutContext);
  const settings = useTradingValue(props.session.ticketSettings);
  const [error, setError] = createSignal<string>();
  async function change(
    name: keyof OrderTicketSettings,
    value: boolean,
  ): Promise<void> {
    setError(undefined);
    try {
      await props.session.host.setOrderTicketSetting(name, value);
    } catch {
      setError("Your display choice could not be saved.");
    }
  }
  return (
    <DropdownMenu placement="bottom-end">
      <DropdownMenu.Trigger
        ref={trigger}
        aria-label="Order ticket settings"
        class="trading-button trading-icon-button"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal mount={popupMount}>
        <DropdownMenu.Content
          class="lumen-trading trading-ticket-menu"
          onCloseAutoFocus={(event) => {
            if (!openProperties) return;
            event.preventDefault();
            openProperties = false;
            // Capture the persistent trigger as the dialog's return target.
            queueMicrotask(() => {
              if (!alive || !trigger.isConnected) return;
              trigger.focus();
              props.session.host.showTradingProperties();
            });
          }}
        >
          <Show
            when={
              layout?.state().supported &&
              (props.session.features.order_panel_undock ||
                layout.state().desiredFloating)
            }
          >
            <DropdownMenu.Item
              class="trading-menu-item"
              disabled={
                !layout?.state().canFloat && !layout?.state().desiredFloating
              }
              onSelect={() => {
                layout?.placement.toggle();
              }}
            >
              <span class="trading-menu-check" aria-hidden="true">
                ↗
              </span>
              {layout?.state().desiredFloating
                ? "Dock order ticket"
                : "Undock order ticket"}
            </DropdownMenu.Item>
            <DropdownMenu.Separator class="trading-menu-divider" />
          </Show>
          <DropdownMenu.CheckboxItem
            class="trading-menu-item"
            checked={settings().showRelativePriceControl}
            onChange={(value) => {
              void change("showRelativePriceControl", value);
            }}
            closeOnSelect={false}
          >
            <span class="trading-menu-check" aria-hidden="true">
              <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
            </span>
            Show order price in ticks
          </DropdownMenu.CheckboxItem>
          <Show when={props.previewAvailable}>
            <DropdownMenu.CheckboxItem
              class="trading-menu-item"
              checked={settings().showOrderPreview}
              disabled={props.session.confirmationRequired}
              closeOnSelect={false}
              onChange={(value) => {
                void change("showOrderPreview", value);
              }}
            >
              <span class="trading-menu-check" aria-hidden="true">
                <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
              </span>
              Show order confirmation
            </DropdownMenu.CheckboxItem>
          </Show>
          <DropdownMenu.Separator class="trading-menu-divider" />
          <DropdownMenu.Item
            class="trading-menu-item"
            onSelect={() => {
              openProperties = true;
            }}
          >
            <span class="trading-menu-check" />
            Trading settings…
          </DropdownMenu.Item>
          <Show when={error()}>
            <p role="status" class="trading-error">
              {error()}
            </p>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
