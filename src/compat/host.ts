import type { Execution, OrderTicketSettings, TradingQuotes } from "../contracts/broker.js";
import { contextOrderType, contextTradeLabel, markDefaultTradeAction, markTradingSettingsAction } from "../core/context-orders.js";
import {
  NotificationType,
  OrderType,
  Side,
} from "../contracts/broker.js";
import type {
  BrokerConfigFlags,
  DOMData,
  IBrokerConnectionAdapterHost,
  InstrumentInfo,
  OrderDurationMetaInfo,
} from "../contracts/broker.js";
import type { TradingSessionOptions } from "../core/session-types.js";
import type { TradingDiagnostic } from "../contracts/ports.js";
import type { TradingState } from "../core/trading-state.js";
import type { SnapshotDataset } from "../core/snapshot-dataset.js";
import type {
  Order,
  Position,
  IndividualPosition,
} from "../contracts/broker.js";
import { DialogCoordinator } from "../core/dialog-coordinator.js";
import { DisposalScope } from "../core/disposal.js";
import { TradingError } from "../core/errors.js";
import { snapshot } from "../core/immutable.js";
import type { NotificationLog } from "../core/notification-log.js";
import { finite } from "../core/entity-validation.js";
import { createHostFactory } from "./factory.js";
import { createHostPreferences } from "./host-preferences.js";
import { createHostDialogs } from "./host-dialogs.js";
export interface HostServices {
  readonly state: TradingState;
  readonly scope: DisposalScope;
  readonly cancellingBothBracketsOnly?: () => boolean;
  /** Opens the host's trading settings page; false falls back to the platform's own dialog. */
  readonly openSettings?: () => boolean;
  readonly ticketSettingsChanged: (
    value: Readonly<
      OrderTicketSettings
    >,
  ) => void;
  readonly dialogs: DialogCoordinator;
  readonly notifications: NotificationLog;
  readonly orders: SnapshotDataset<Order>;
  readonly positions: SnapshotDataset<Position>;
  readonly individualPositions: SnapshotDataset<IndividualPosition>;
  readonly active: () => boolean;
  readonly read: <T>(load: () => T | Promise<T>) => Promise<T>;
  readonly update: (callback: () => void) => void;
  /** Receives broker input the host dropped. */
  readonly diagnostic?: (diagnostic: TradingDiagnostic) => void;
  readonly connectionChanged: IBrokerConnectionAdapterHost["connectionStatusUpdate"];
  readonly accountChanged: () => void;
  readonly patchConfig: (patch: Partial<BrokerConfigFlags>) => void;
  readonly setDurations: (durations: OrderDurationMetaInfo[]) => void;
  readonly symbolInfo: (symbol: string) => Promise<InstrumentInfo>;
  readonly quoteUpdate: (
    symbol: string,
    data: TradingQuotes,
  ) => void;
  readonly executionUpdate?: (
    execution: Execution,
  ) => void;
  readonly depthUpdate: (symbol: string, data: DOMData) => void;
}
export function createTradingHost(
  options: TradingSessionOptions & { readonly settingsKey: string },
  services: HostServices,
): IBrokerConnectionAdapterHost {
  const { state, scope, dialogs } = services;
  const refresh = (
    dataset: SnapshotDataset<Order> | SnapshotDataset<Position> | SnapshotDataset<IndividualPosition>,
  ) => {
    if (services.active()) void dataset.refresh().catch(() => {});
  };
  const report = services.diagnostic ?? (() => {});
  const preferences = createHostPreferences(
    options.settings,
    options.settingsKey,
    !!options.requireConfirmation,
    async (symbol) => {
      const instrument = await services.symbolInfo(symbol);
      return instrument.qty.default ?? instrument.qty.min;
    },
    scope,
    services.ticketSettingsChanged,
    (method, cause) => report({ source: "host", method, message: cause instanceof Error ? cause.message : String(cause) }),
  );
  const ui = createHostDialogs(
    dialogs,
    options.brokerConfig?.customUI,
    (id) => state.orders.get(id),
    (id) => state.positions.get(id),
    () => {
      if (!services.active())
        throw TradingError.disposed();
      return state.connection.get().generation;
    },
    () => services.cancellingBothBracketsOnly?.() ?? false,
    () => services.openSettings?.() ?? false,
  );
  /** Runs one push; invalid broker input becomes a diagnostic, never an exception in the adapter. */
  const guarded = (method: string, entityId: string | undefined, work: () => void) => {
    try {
      work();
    } catch (cause) {
      report({
        source: "host",
        method,
        ...(entityId !== undefined ? { entityId } : {}),
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const entityId = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
    return undefined;
  };
  // Buffered pushes apply later (after a snapshot), so the apply step carries its own guard.
  const update = (method: string, id: string | undefined, apply: () => void) =>
    guarded(method, id, () => services.update(() => guarded(method, id, apply)));
  const dataUpdate = <T>(method: string, value: T, apply: (value: T) => void, id = entityId(value)) => {
    if (!services.active()) return;
    guarded(method, id, () => {
      const copied = snapshot(value);
      update(method, id, () => apply(copied));
    });
  };
  const host: IBrokerConnectionAdapterHost = {
    ...preferences,
    ...ui,
    factory: createHostFactory(options.formatters, scope),
    connectionStatusUpdate: services.connectionChanged,
    currentAccountUpdate: services.accountChanged,
    defaultFormatter: (symbol, align) =>
      services.read(() => options.formatters.defaultPrice(symbol, align)),
    numericFormatter: (places) =>
      services.read(() => options.formatters.numeric(places)),
    quantityFormatter: (places) =>
      services.read(() => options.formatters.quantity(places)),
    getSymbolMinTick: async (symbol) =>
      (await services.symbolInfo(symbol)).minTick,
    patchConfig: (patch) => {
      if (services.active()) services.patchConfig(patch);
    },
    setDurations: (durations) => {
      if (services.active()) services.setDurations(durations);
    },
    orderUpdate: (entity) =>
      dataUpdate("orderUpdate", entity, (value) => services.orders.push(value)),
    orderPartialUpdate: (id, patch) =>
      dataUpdate("orderPartialUpdate", patch, (value) => services.orders.partial(id, value), id),
    ordersFullUpdate: () => refresh(services.orders),
    positionUpdate: (entity, history) =>
      dataUpdate("positionUpdate", entity, (value) => {
        if (!history) services.positions.push(value);
      }),
    positionPartialUpdate: (id, patch) =>
      dataUpdate("positionPartialUpdate", patch, (value) => services.positions.partial(id, value), id),
    positionsFullUpdate: () => refresh(services.positions),
    individualPositionUpdate: (entity, history) =>
      dataUpdate("individualPositionUpdate", entity, (value) => {
        if (!history) services.individualPositions.push(value);
      }),
    individualPositionPartialUpdate: (id, patch) =>
      dataUpdate("individualPositionPartialUpdate", patch, (value) => services.individualPositions.partial(id, value), id),
    individualPositionsFullUpdate: () => refresh(services.individualPositions),
    executionUpdate: (entity) =>
      dataUpdate("executionUpdate", entity, (value) => {
        if (services.executionUpdate) services.executionUpdate(value);
        else state.executions.upsert(value);
      }),
    realtimeUpdate: (symbol, quotes) =>
      dataUpdate("realtimeUpdate", quotes, (value) => services.quoteUpdate(symbol, value), symbol),
    plUpdate: (id, value) =>
      update("plUpdate", id, () => {
        services.positions.afterUpdates(id, () => guarded("plUpdate", id, () => {
          // P&L for a position the session does not hold would accumulate without an owner.
          if (!state.positions.get(id)) return;
          finite(value, "profit and loss");
          state.tablePL.upsert({ id, value });
        }));
      }),
    individualPositionPLUpdate: (id, value) =>
      update("individualPositionPLUpdate", id, () => {
        services.individualPositions.afterUpdates(id, () => guarded("individualPositionPLUpdate", id, () => {
          if (!state.individualPositions.get(id)) return;
          finite(value, "profit and loss");
          state.individualTablePL.upsert({ id, value });
        }));
      }),
    equityUpdate: (value) =>
      update("equityUpdate", undefined, () => {
        finite(value, "equity");
        state.equity.set(value);
      }),
    marginAvailableUpdate: (value) =>
      update("marginAvailableUpdate", undefined, () => {
        finite(value, "available margin");
        state.marginAvailable.set(value);
      }),
    cryptoBalanceUpdate: (symbol, balance) =>
      dataUpdate("cryptoBalanceUpdate", balance, (value) => {
        state.balances.upsert({ ...value, id: symbol });
      }, symbol),
    pipValueUpdate: (symbol, values) =>
      dataUpdate("pipValueUpdate", values, (value) => {
        state.pipValues.upsert({ ...value, id: symbol });
      }, symbol),
    domUpdate: (symbol, data) =>
      dataUpdate("domUpdate", data, (value) => services.depthUpdate(symbol, value), symbol),
    showNotification: (title, text, type = NotificationType.Error) => {
      if (!services.active()) return;
      services.notifications.push({ title, text, type });
    },
    defaultContextMenuActions: async (context) => {
      const actions = [];
      const price =
        typeof context.value === "number" && Number.isFinite(context.value)
          ? context.value
          : undefined;
      const market = Number.isFinite(context.last) ? context.last : undefined;
      for (const side of [Side.Buy, Side.Sell] as const) {
        // At a chart price: "Buy SYMBOL @ 99.40 Limit"; otherwise a market order.
        const type =
          price !== undefined && market !== undefined
            ? contextOrderType(side, price, market)
            : OrderType.Market;
        const label = contextTradeLabel({
          side,
          symbol: context.displaySymbol || context.symbol,
          formattedPrice: context.formattedValue || String(price),
          type,
        });
        const item = {
          text: label,
          action: () => {
            void host
              .getQty(context.symbol)
              .then((qty) =>
                host.showOrderDialog?.({
                  symbol: context.symbol,
                  side,
                  type,
                  qty,
                  ...(type === OrderType.Limit ? { limitPrice: price } : {}),
                  ...(type === OrderType.Stop ? { stopPrice: price } : {}),
                }),
              )
              .catch(() => {});
          },
        };
        markDefaultTradeAction(item, side);
        actions.push(item);
      }
      const settings = {
        text: "Trading settings",
        action: () => host.showTradingProperties(),
      };
      markTradingSettingsAction(settings);
      actions.push(settings);
      return actions;
    },
    defaultDropdownMenuActions: (options) => {
      const actions = [];
      if (options?.tradingProperties !== false)
        actions.push({
          text: "Trading settings",
          action: () => host.showTradingProperties(),
        });
      if (options?.restoreConfirmations !== false)
        actions.push({
          text: "Restore confirmations",
          action: () => host.silentOrdersPlacement().setValue(false),
        });
      return actions;
    },
  };
  return host;
}
