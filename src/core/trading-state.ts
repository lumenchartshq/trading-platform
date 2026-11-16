import type {
  CryptoBalance,
  DisconnectType,
  Execution,
  IndividualPosition,
  Order,
  PipValues,
  Position,
  TradingQuotes,
} from "../contracts/broker.js";
import { ConnectionStatus } from "../contracts/broker.js";
import { EntityStore } from "./entity-store.js";
import {
  acceptOrder,
  finite,
  validateExecution,
  validateIndividualPosition,
  validateOrder,
  validatePosition,
} from "./entity-validation.js";
import { ValueStore } from "./value-store.js";
export interface FinancialValue {
  id: string;
  value: number;
}
export type ConnectionPhase =
  | "initializing"
  | "hydrating"
  | "ready"
  | "switching"
  | "disconnected"
  | "error"
  | "disposed";
/** Broker-supplied disconnection details, reduced to bounded display text. `reason` is analytics-only and not kept. */
export interface ConnectionNotice {
  heading?: string;
  message?: string;
  additionalInfo?: string;
  disconnectType?: DisconnectType;
}
export interface ConnectionState {
  status: ConnectionStatus;
  phase: ConnectionPhase;
  generation: number;
  accountId?: string;
  error?: string;
  notice?: ConnectionNotice;
}
const noticeText = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : undefined;
export function connectionNotice(info: unknown): ConnectionNotice | undefined {
  if (!info || typeof info !== "object") return undefined;
  const value = info as Record<string, unknown>;
  const notice: ConnectionNotice = {
    heading: noticeText(value.heading),
    message: noticeText(value.message),
    additionalInfo: noticeText(value.additionalInfo),
    disconnectType:
      typeof value.disconnectType === "number" &&
      Number.isInteger(value.disconnectType)
        ? (value.disconnectType as DisconnectType)
        : undefined,
  };
  return Object.values(notice).some((item) => item !== undefined)
    ? notice
    : undefined;
}
/** Stores only broker-confirmed data; table-only PL has its own keyed channel. */
export function createTradingState() {
  const orders = new EntityStore<Order>(validateOrder, acceptOrder);
  const history = new EntityStore<Order>(validateOrder);
  const positions = new EntityStore<Position>(validatePosition);
  const individualPositions = new EntityStore<IndividualPosition>(
    validateIndividualPosition,
  );
  const executions = new EntityStore<Execution>(validateExecution);
  const financial = () =>
    new EntityStore<FinancialValue>((entry) =>
      finite(entry.value, "financial value"),
    );
  const tablePL = financial();
  const individualTablePL = financial();
  positions.subscribeChanges((change) => {
    for (const id of change.removed) tablePL.remove(id);
  });
  individualPositions.subscribeChanges((change) => {
    for (const id of change.removed) individualTablePL.remove(id);
  });
  const equity = new ValueStore<number | undefined>(undefined);
  const marginAvailable = new ValueStore<number | undefined>(undefined);
  const balances = new EntityStore<CryptoBalance & { id: string }>((entry) => {
    finite(entry.total, "balance");
    finite(entry.available, "available balance");
  });
  const quotes = new EntityStore<TradingQuotes & { id: string }>(() => {});
  const pipValues = new EntityStore<PipValues & { id: string }>((entry) => {
    finite(entry.buyPipValue, "buy pip value");
    finite(entry.sellPipValue, "sell pip value");
  });
  const connection = new ValueStore<ConnectionState>({
    status: ConnectionStatus.Connecting,
    phase: "initializing",
    generation: 0,
  });
  const entities = [
    orders,
    history,
    positions,
    individualPositions,
    executions,
    tablePL,
    individualTablePL,
    balances,
    quotes,
    pipValues,
  ];
  const clearAccount = () => {
    for (const store of entities)
      for (const id of store.ids()) store.remove(id);
    equity.set(undefined);
    marginAvailable.set(undefined);
  };
  return {
    orders,
    history,
    positions,
    individualPositions,
    executions,
    tablePL,
    individualTablePL,
    equity,
    marginAvailable,
    balances,
    quotes,
    pipValues,
    connection,
    clearAccount,
    positionUpdate(position: Position): void {
      if (position.qty === 0) {
        positions.remove(position.id);
        tablePL.remove(position.id);
      } else positions.upsert(position);
    },
    individualPositionUpdate(position: IndividualPosition): void {
      if (position.qty === 0) {
        individualPositions.remove(position.id);
        individualTablePL.remove(position.id);
      } else individualPositions.upsert(position);
    },
    destroy(): void {
      for (const store of entities) store.destroy();
      equity.destroy();
      marginAvailable.destroy();
      connection.destroy();
    },
  };
}
export type TradingState = ReturnType<typeof createTradingState>;
