import type { AccountManagerInfo, AccountManagerColumn } from "../../contracts/broker.js";
import type { CapabilityFlags } from "../../core/capabilities.js";
import type { TradingFeatures } from "../../core/features.js";
import { defaultStatusFilters } from "./table-controls.js";

export interface AccountPage {
  readonly id: "positions" | "individual" | "orders" | "history" | "notifications";
  readonly reader: "positions" | "individualPositions" | "orders" | "history";
  readonly actions?: "orders" | "positions" | "individual";
  title(flags: CapabilityFlags): string;
  enabled(flags: CapabilityFlags, features: TradingFeatures): boolean;
  columns(metadata: AccountManagerInfo | undefined): readonly AccountManagerColumn[];
  sorting?(metadata: AccountManagerInfo | undefined): AccountManagerInfo["orderColumnsSorting"];
  statuses?(metadata: AccountManagerInfo | undefined): readonly number[];
  /** What an empty table says; defaults to `DEFAULT_EMPTY_MESSAGE`. */
  readonly emptyMessage?: string;
}
export const DEFAULT_EMPTY_MESSAGE = "There is no trading data here yet";
const NO_POSITIONS_MESSAGE = "There are no open positions in your trading account yet";
export const accountPages: readonly AccountPage[] = [
  {
    id: "positions", reader: "positions", actions: "positions", emptyMessage: NO_POSITIONS_MESSAGE,
    title: flags => flags.supportPositionNetting ? "Net positions" : "Positions",
    enabled: flags => flags.supportPositions,
    columns: metadata => metadata?.positionColumns ?? [],
  },
  {
    id: "individual", reader: "individualPositions", actions: "individual", emptyMessage: NO_POSITIONS_MESSAGE,
    title: () => "Individual positions",
    enabled: flags => flags.supportPositionNetting,
    columns: metadata => metadata?.individualPositionColumns ?? metadata?.positionColumns ?? [],
  },
  {
    id: "orders", reader: "orders", actions: "orders",
    title: () => "Orders", enabled: () => true,
    columns: metadata => metadata?.orderColumns ?? [],
    sorting: metadata => metadata?.orderColumnsSorting,
    statuses: metadata => metadata?.possibleOrderStatuses ?? defaultStatusFilters,
  },
  {
    id: "history", reader: "history", title: () => "History",
    enabled: flags => flags.supportOrdersHistory,
    columns: metadata => metadata?.historyColumns ?? metadata?.orderColumns ?? [],
    sorting: metadata => metadata?.historyColumnsSorting,
  },
  {
    id: "notifications", reader: "orders", title: () => "Notifications log",
    enabled: (flags, features) => flags.showNotificationsLog && features.show_trading_notifications_history,
    columns: () => [],
  },
];
export function accountPage(id: string): AccountPage {
  return accountPages.find(page => page.id === id) ?? accountPages[2];
}
