import type { IBrokerTerminal, Order } from "../contracts/broker.js";
import type { TradingClock, TradingDiagnostic } from "../contracts/ports.js";
import type { CapabilityFlags } from "./capabilities.js";
import { TradingError } from "./errors.js";
import { DEFAULT_HISTORY_LIMIT, limitHistory } from "./history-limit.js";
import { SnapshotDataset } from "./snapshot-dataset.js";
import type { TradingState } from "./trading-state.js";

export interface AccountDatasetOptions {
  readonly state: TradingState;
  readonly broker: () => IBrokerTerminal;
  readonly clock: TradingClock;
  readonly diagnostic: (diagnostic: TradingDiagnostic) => void;
  /** Snapshot read deadline in milliseconds. */
  readonly deadline: number;
  readonly historyLimit?: number;
}

/**
 * The four account snapshot datasets (orders, history, positions, individual positions). Each read quarantines
 * invalid rows; position reads drop quantity-zero rows; history reads keep the newest `historyLimit` rows.
 */
export function createAccountDatasets(options: AccountDatasetOptions) {
  const { state, broker, clock, diagnostic, deadline } = options;
  const report = (method: string) => (message: string, entityId?: string) =>
    diagnostic({ source: "snapshot", method, ...(entityId !== undefined ? { entityId } : {}), message });
  const orders = new SnapshotDataset(
    state.orders,
    () => broker().orders(),
    clock,
    undefined,
    report("orders"),
    undefined,
    true,
    deadline,
  );
  const history = new SnapshotDataset(
    state.history,
    () => {
      const current = broker();
      if (!current.ordersHistory) throw new TradingError("configuration", "Order history is unavailable.");
      return current.ordersHistory().then((rows) => {
        const limited = limitHistory(rows, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
        if (limited.dropped)
          diagnostic({
            source: "history",
            method: "ordersHistory",
            message: `Kept the newest ${limited.rows.length} history rows and dropped ${limited.dropped}.`,
          });
        return limited.rows as Order[];
      });
    },
    clock,
    undefined,
    report("ordersHistory"),
    undefined,
    true,
    deadline,
  );
  const positions = new SnapshotDataset(
    state.positions,
    () => {
      const current = broker();
      if (!current.positions) throw new TradingError("configuration", "Positions are unavailable.");
      return current.positions();
    },
    clock,
    (value) => state.positionUpdate(value),
    report("positions"),
    (value) => value.qty !== 0,
    true,
    deadline,
  );
  const individualPositions = new SnapshotDataset(
    state.individualPositions,
    () => {
      const current = broker();
      const method = current.individualPositions;
      if (!method) throw new TradingError("configuration", "Individual positions are unavailable.");
      return method.call(current);
    },
    clock,
    (value) => state.individualPositionUpdate(value),
    report("individualPositions"),
    (value) => value.qty !== 0,
    true,
    deadline,
  );
  const all = [orders, history, positions, individualPositions] as const;
  return {
    orders,
    history,
    positions,
    individualPositions,
    all,
    /** Starts the snapshot reads the capabilities call for; pushes buffer behind them. */
    beginSnapshots(flags: CapabilityFlags): Promise<void>[] {
      const pending = [orders.refresh()];
      if (flags.supportOrdersHistory) pending.push(history.refresh());
      if (flags.supportPositions) pending.push(positions.refresh());
      if (flags.supportPositionNetting) pending.push(individualPositions.refresh());
      return pending;
    },
    destroy(): void {
      for (const dataset of all) dataset.destroy();
    },
  };
}
export type AccountDatasets = ReturnType<typeof createAccountDatasets>;
