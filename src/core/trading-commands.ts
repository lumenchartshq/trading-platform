import type {
  BrokerCustomUI,
  IBrokerTerminal,
  InstrumentInfo,
  Order,
  OrderDialogOptions,
  OrderPreviewResult,
  PreOrder,
  Side,
  TradingDialogOptions,
} from "../contracts/broker.js";
import type { LumenBrokerExtensions } from "../contracts/ports.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { CloseCommands } from "./close-commands.js";
import { entityStore } from "./command-context.js";
import type { CommandCoordinator, TradingCommandResult } from "./command-coordinator.js";
import { LeverageCommands, type LeverageChangeRequest, type LeverageRequest } from "./leverage-commands.js";
import { captureModificationParent, type ModificationParentContext } from "./modification-context.js";
import { OrderCommands } from "./order-commands.js";
import {
  editTradingProtection,
  reverseTradingPosition,
  type CloseRequest,
  type PositionCommandServices,
  type PositionRequest,
  type ProtectionRequest,
} from "./position-commands.js";
import type { TradingState } from "./trading-state.js";
export interface TradingCommandContext {
  readonly accountId: string;
  readonly generation: number;
  readonly revision?: number;
  readonly parent?: ModificationParentContext;
}
export interface PlaceRequest {
  readonly context: TradingCommandContext;
  readonly order: PreOrder;
  readonly confirmId?: string;
  readonly previewToken?: string;
}
export interface ModifyRequest {
  readonly context: TradingCommandContext;
  readonly order: Order;
  readonly confirmId?: string;
  readonly previewToken?: string;
}
export interface EntityRequest {
  readonly context: TradingCommandContext;
  readonly id: string;
}
export interface TradingCommandServices {
  readonly broker: IBrokerTerminal;
  readonly alwaysPassCalledOrderToModify?: boolean;
  readonly beginProtectionNotifications?: PositionCommandServices["beginProtectionNotifications"];
  readonly state: TradingState;
  readonly coordinator: CommandCoordinator;
  readonly policy: (symbol?: string) => CapabilityPolicy;
  readonly orderPreviewEnabled?: () => boolean;
  readonly symbolInfo: (symbol: string) => Promise<InstrumentInfo>;
  readonly now: () => number;
  /** Expiry validation tolerance for a session clock ahead of the broker (default 60 s). */
  readonly clockSkewToleranceSeconds?: number;
  readonly read: <T>(load: () => T | Promise<T>) => Promise<T>;
  readonly refreshLeverageDependencies: (symbol: string) => Promise<void>;
  readonly refresh: () => void;
  readonly refreshPositions?: () => Promise<void>;
  readonly orderOptions?: (
    symbol: string,
  ) => Promise<
    | OrderDialogOptions
    | undefined
  >;
  readonly extensions?: LumenBrokerExtensions;
  readonly closePreview?: NonNullable<
    LumenBrokerExtensions["previewClosePosition"]
  >;
  readonly customClose?: NonNullable<
    BrokerCustomUI["showClosePositionDialog"]
  >;
  readonly positionOptions?: (
    symbol: string,
  ) => Promise<
    | TradingDialogOptions
    | undefined
  >;
  readonly selectAccount: (accountId: string) => Promise<void>;
}

export interface LumenOrderPreview {
  readonly token: string;
  readonly preview: Readonly<OrderPreviewResult>;
}

/**
 * Facade over the command modules: orders (`order-commands.ts`), closing (`close-commands.ts`), positions
 * (`position-commands.ts`) and leverage (`leverage-commands.ts`). The public surface is unchanged.
 */
export class TradingCommands {
  private previewSequence = 0;
  private readonly orders: OrderCommands;
  private readonly closes: CloseCommands;
  private readonly leverage: LeverageCommands;
  constructor(private readonly services: TradingCommandServices) {
    // Order and close review tokens share one sequence.
    const next = () => ++this.previewSequence;
    this.orders = new OrderCommands(services, next);
    this.closes = new CloseCommands(services, next);
    this.leverage = new LeverageCommands({
      ...services,
      validateContext: (context) => this.orders.validateContext(context),
      refreshDependencies: services.refreshLeverageDependencies,
      invalidatePreviews: (symbol) => this.orders.invalidateSymbol(symbol),
    });
  }
  invalidatePreviews(): void {
    this.orders.clear();
    this.closes.clear();
    this.leverage.clearReviews();
  }
  leverageInfo(request: LeverageRequest) {
    return this.leverage.info(request);
  }
  previewLeverage(request: LeverageChangeRequest) {
    return this.leverage.review(request);
  }
  setLeverage(request: LeverageChangeRequest) {
    return this.leverage.set(request);
  }
  context(id?: string, kind: "order" | "position" | "individualPosition" = "order"): TradingCommandContext {
    const connection = this.services.state.connection.get();
    return Object.freeze({
      accountId: connection.accountId ?? "",
      generation: connection.generation,
      parent: id && kind === "order" ? captureModificationParent(this.services.state, id) : undefined,
      revision: id ? entityStore(this.services.state, kind).revision(id) : undefined,
    });
  }
  place(request: PlaceRequest): Promise<TradingCommandResult> {
    return this.orders.place(request);
  }
  validate(request: PlaceRequest): Promise<void> {
    return this.orders.validate(request);
  }
  preview(request: PlaceRequest): Promise<LumenOrderPreview> {
    return this.orders.preview(request);
  }
  modify(request: ModifyRequest): Promise<TradingCommandResult> {
    return this.orders.modify(request);
  }
  cancel(request: EntityRequest): Promise<TradingCommandResult> {
    return this.orders.cancel(request);
  }
  cancelMany(request: {
    context: TradingCommandContext;
    symbol: string;
    side?: Side;
    orders: readonly { id: string; revision: number }[];
  }): Promise<readonly { id: string; result?: TradingCommandResult; error?: unknown }[]> {
    return this.orders.cancelMany(request);
  }
  previewClose(request: CloseRequest) {
    return this.closes.previewClose(request);
  }
  confirmCustomClose(request: CloseRequest) {
    return this.closes.confirmCustomClose(request);
  }
  close(request: CloseRequest): Promise<TradingCommandResult> {
    return this.closes.close(request);
  }
  reverse(request: PositionRequest): Promise<TradingCommandResult> {
    return reverseTradingPosition(this.services, request);
  }
  editProtection(request: ProtectionRequest): Promise<TradingCommandResult> {
    return editTradingProtection(this.services, request);
  }
  selectAccount(accountId: string): Promise<void> {
    return this.services.selectAccount(accountId);
  }
}
