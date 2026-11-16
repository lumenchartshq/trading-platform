import { TradingTabs } from "../tabs.js";
import { Popover } from "@kobalte/core/popover";
import { TradingPopupMount } from "../popup-mount.js";
import { For, Show, createSignal, createUniqueId, useContext } from "solid-js";
import {
  OrderStatus,
  OrderStatusFilter,
} from "../../contracts/broker.js";
import type { AccountManagerColumn } from "../../contracts/broker.js";
import { TradingButton } from "../primitives.js";
const statusNames: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.Canceled]: "Cancelled",
};
function statusName(status: OrderStatus | OrderStatusFilter.All): string {
  if (status === OrderStatusFilter.All) return "All";
  return statusNames[status] ?? OrderStatus[status];
}
export function TableStatusTabs(props: {
  label: string;
  status: OrderStatus | OrderStatusFilter.All;
  statuses: readonly OrderStatus[];
  counts: ReadonlyMap<unknown, number>;
  total: number;
  onStatus(value: OrderStatus | OrderStatusFilter.All): void;
}) {
  return (
    <div class="trading-table-toolbar">
      <TradingTabs
        class="trading-status-tabs"
        label={`${props.label} status`}
        value={props.status}
        tabs={(
          [
            OrderStatusFilter.All,
            ...props.statuses,
          ] as readonly (OrderStatus | OrderStatusFilter.All)[]
        ).map((status) => ({
          value: status,
          label: (
            <>
              {statusName(status)}{" "}
              <span class="trading-tab-count">
                {status === OrderStatusFilter.All
                  ? props.total
                  : (props.counts.get(status) ?? 0)}
              </span>
            </>
          ),
        }))}
        onChange={props.onStatus}
      />
    </div>
  );
}

export function TableTools(props: {
  label: string;
  query: string;
  onQuery(value: string): void;
  exporting: boolean;
  canExport: boolean;
  onExport(): void;
}) {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const searchId = createUniqueId();
  let input!: HTMLInputElement;
  let trigger!: HTMLButtonElement;

  function toggleSearch(): void {
    if (searchOpen()) {
      props.onQuery("");
      setSearchOpen(false);
      trigger.focus();
      return;
    }
    setSearchOpen(true);
    input.focus();
  }

  return (
    <div class="trading-table-tools">
      <input
        ref={input}
        id={searchId}
        type="search"
        hidden={!searchOpen()}
        aria-label={`Search ${props.label}`}
        placeholder="Search"
        value={props.query}
        onInput={(event) => props.onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          toggleSearch();
        }}
      />
      <TradingButton
        ref={trigger}
        class="trading-icon-button"
        aria-label={`Find in ${props.label}`}
        aria-controls={searchId}
        aria-expanded={searchOpen()}
        title={searchOpen() ? "Close search" : "Search"}
        onClick={toggleSearch}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <Show when={!searchOpen()} fallback={<path d="m6 6 12 12M18 6 6 18" />}>
            <circle cx="10.5" cy="10.5" r="5.5" />
            <path d="m15 15 4 4" />
          </Show>
        </svg>
      </TradingButton>
      <TradingButton
        class="trading-icon-button"
        disabled={!props.canExport || props.exporting}
        onClick={props.onExport}
        aria-label="Export CSV"
        aria-busy={props.exporting}
        title={props.exporting ? "Preparing…" : "Export CSV"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5" />
        </svg>
      </TradingButton>
    </div>
  );
}

export function TableColumns(props: {
  label: string;
  columns: readonly AccountManagerColumn[];
  visible: readonly AccountManagerColumn[];
  onColumn(id: string, visible: boolean): void;
  onResetColumns(): void;
}) {
  const popupMount = useContext(TradingPopupMount);
  return (
    <Popover placement="top-end">
      <Popover.Trigger class="trading-button trading-icon-button" title="Columns">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="6" width="3" height="12" rx="1" />
          <rect x="11" y="6" width="3" height="12" rx="1" />
          <rect x="17" y="6" width="3" height="12" rx="1" />
        </svg>
        <span class="trading-visually-hidden">Columns</span>
      </Popover.Trigger>
      <Popover.Portal mount={popupMount}>
        <Popover.Content class="lumen-trading trading-column-popover">
          <Popover.Title class="trading-visually-hidden">
            Columns for {props.label}
          </Popover.Title>
          <fieldset>
            <legend class="trading-visually-hidden">Visible columns</legend>
            <For each={props.columns}>
              {(column) => {
                const checked = () =>
                  props.visible.some((visible) => visible.id === column.id);
                return (
                  <label class="trading-check">
                    <input
                      type="checkbox"
                      checked={checked()}
                      disabled={
                        column.notHideable ||
                        (checked() && props.visible.length === 1)
                      }
                      onChange={(event) =>
                        props.onColumn(
                          column.id,
                          event.currentTarget.checked,
                        )
                      }
                    />
                    <span>{column.label}</span>
                  </label>
                );
              }}
            </For>
          </fieldset>
          <TradingButton onClick={props.onResetColumns}>
            Reset columns
          </TradingButton>
          <Popover.CloseButton class="trading-button" aria-label="Done">
            Done
          </Popover.CloseButton>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
