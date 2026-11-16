import type {
  InstrumentInfo,
  Order,
  OrderPreviewResult,
  PlaceOrderResult,
  PreOrder,
  Side,
} from "../contracts/broker.js";
import { OrderStatus, OrderType } from "../contracts/broker.js";
import { validateBracketEditInput } from "./bracket-modification.js";
import { assertLiveContext, assertRevision, isLiveContext } from "./command-context.js";
import type { TradingCommandResult } from "./command-coordinator.js";
import { commandKeys } from "./command-keys.js";
import { terminalStatuses } from "./entity-validation.js";
import { TradingError, brokerRejectionError } from "./errors.js";
import { equalData, snapshot } from "./immutable.js";
import { assertModificationParent } from "./modification-context.js";
import { existingOrderId, routeModification, type ModificationRoute } from "./modification-routing.js";
import { withDefaultDuration } from "./order-duration.js";
import { matchesIdentifiedOrder, matchesOrder } from "./order-matching.js";
import { assertOrderModification } from "./order-modification.js";
import { hasOrderProtection, prepareOrderProtection } from "./order-protection.js";
import { editTradingProtection, type PositionCommandServices } from "./position-commands.js";
import { PreviewLeases } from "./preview-leases.js";
import { assertTradable } from "./tradability.js";
import { validatePreOrder } from "./trading-rules.js";
import type {
  EntityRequest,
  LumenOrderPreview,
  ModifyRequest,
  PlaceRequest,
  TradingCommandContext,
  TradingCommandServices,
} from "./trading-commands.js";

/** What order commands use; positions are reached through `editTradingProtection` for child exits of positions. */
export type OrderCommandServices = PositionCommandServices &
  Pick<
    TradingCommandServices,
    | "alwaysPassCalledOrderToModify"
    | "orderPreviewEnabled"
    | "now"
    | "clockSkewToleranceSeconds"
    | "read"
    | "orderOptions"
  >;

interface OrderPreviewLease {
  readonly order: Readonly<PreOrder>;
  readonly preparedOrder: Readonly<PreOrder>;
  readonly context: TradingCommandContext;
  readonly preview: Readonly<OrderPreviewResult>;
}

/** Placement, modification, cancellation and order previews. */
export class OrderCommands {
  private readonly previews: PreviewLeases<OrderPreviewLease>;
  constructor(
    private readonly services: OrderCommandServices,
    nextSequence: () => number,
  ) {
    this.previews = new PreviewLeases("preview", 200, nextSequence);
  }
  clear(): void {
    this.previews.clear();
  }
  /** Leverage changes invalidate reviews for their symbol. */
  invalidateSymbol(symbol: string): void {
    this.previews.invalidate((preview) => preview.order.symbol === symbol);
  }
  validateContext(context: TradingCommandContext, id?: string): void {
    assertLiveContext(this.services.state, context);
    if (id) assertRevision(this.services.state, "order", id, context.revision);
  }
  private currentContext(context: TradingCommandContext): boolean {
    return isLiveContext(this.services.state, context);
  }
  private requiresOrderPreview(supported: boolean): boolean {
    return supported && (this.services.orderPreviewEnabled?.() ?? true);
  }
  /**
   * The reviewed preview must still match this request when the broker supports previews for it.
   * Passing the prepared order consumes the lease at dispatch.
   */
  private assertPreview(request: PlaceRequest | ModifyRequest, kind: "place" | "modify", prepared?: PreOrder): void {
    const flags = this.services.policy(request.order.symbol).flags;
    const supported = kind === "place" ? flags.supportPlaceOrderPreview : flags.supportModifyOrderPreview;
    this.requirePreview(request, this.requiresOrderPreview(supported), prepared !== undefined, prepared);
  }
  private requirePreview(
    request: PlaceRequest | ModifyRequest,
    required: boolean,
    consume = false,
    preparedOrder?: PreOrder,
  ): void {
    if (!required && !request.previewToken) return;
    const lease = this.previews.claim(
      request.previewToken,
      (lease) =>
        equalData(lease.context, request.context) &&
        equalData(lease.order, request.order) &&
        (preparedOrder === undefined || equalData(lease.preparedOrder, preparedOrder)) &&
        lease.preview.confirmId === request.confirmId &&
        !lease.preview.errors?.length,
      consume,
    );
    if (!lease) throw new TradingError("invalid-input", "Review the current order before sending it.");
  }
  async place(request: PlaceRequest): Promise<TradingCommandResult> {
    const { broker, state, coordinator, refresh } = this.services;
    let order = snapshot({ ...request.order, type: request.order.type ?? OrderType.Market }) as PreOrder;
    this.validateContext(request.context);
    const instrument = await this.services.symbolInfo(order.symbol);
    const tradable = await this.services.read(() => broker.isTradable(order.symbol));
    this.validateContext(request.context);
    assertTradable(tradable);
    const policy = this.services.policy(order.symbol);
    order = withDefaultDuration(order, policy, instrument);
    this.assertPreview(request, "place");
    validatePreOrder(
      order,
      instrument,
      policy,
      state.quotes.get(order.symbol),
      this.services.now(),
      this.services.clockSkewToleranceSeconds,
    );
    const options = hasOrderProtection(order) ? await this.services.orderOptions?.(order.symbol) : undefined;
    this.validateContext(request.context);
    order = prepareOrderProtection(
      order,
      instrument,
      policy,
      state.quotes.get(order.symbol),
      options?.maxExitLevelsCount,
    );
    const initial = new Set(state.orders.ids());
    const candidates = new Set<string>();
    const unsubscribe = state.orders.subscribeChanges((change) => {
      for (const id of [...change.added, ...change.updated]) if (!initial.has(id)) candidates.add(id);
    });
    return coordinator.execute<PlaceOrderResult>({
      keys: [commandKeys.place(request.context.accountId, order.symbol)],
      dispatch: () => {
        this.assertPreview(request, "place", order);
        return broker.placeOrder(structuredClone(order), request.confirmId);
      },
      match: (result) => {
        if (!this.currentContext(request.context)) return undefined;
        // A returned ID correlates the order; otherwise exactly one new candidate must match every field.
        const identified = result?.orderId;
        const ids = identified ? [identified] : [...candidates];
        const matches = ids
          .map((id) => state.orders.get(id))
          .filter(
            (candidate): candidate is Readonly<Order> =>
              !!candidate &&
              !initial.has(candidate.id) &&
              (identified ? matchesIdentifiedOrder(candidate, order) : matchesOrder(candidate, order, instrument)),
          );
        if (matches.some((candidate) => candidate.status === OrderStatus.Rejected))
          throw new TradingError("broker-rejected", "The broker rejected this order.");
        if (matches.length !== 1) return undefined;
        const candidate = matches[0];
        if (identified && candidate.status === OrderStatus.Canceled)
          return { outcome: "changed", entityIds: [candidate.id] };
        if (![OrderStatus.Placing, OrderStatus.Working, OrderStatus.Filled].includes(candidate.status))
          return undefined;
        return { outcome: "confirmed", entityIds: [candidate.id] };
      },
      refresh,
      dispose: unsubscribe,
    });
  }
  private validateModificationContext(context: TradingCommandContext, id?: string): void {
    this.validateContext(context, id);
    if (!id) return;
    const order = this.services.state.orders.get(id);
    if (order) assertModificationParent(this.services.state, order, context.parent);
  }
  private route(order: PreOrder, context: TradingCommandContext, instrument: InstrumentInfo, maxLevels?: number) {
    return routeModification({
      state: this.services.state,
      order,
      parentContext: context.parent,
      policy: this.services.policy(order.symbol),
      instrument,
      quotes: this.services.state.quotes.get(order.symbol),
      maxLevels,
      passCalledOrder: this.services.alwaysPassCalledOrderToModify,
    });
  }
  private validateOrderDraft(order: PreOrder, context: TradingCommandContext, instrument: InstrumentInfo): void {
    if (context.parent) {
      validateBracketEditInput(order as Order, instrument);
      return;
    }
    validatePreOrder(
      order,
      instrument,
      this.services.policy(order.symbol),
      this.services.state.quotes.get(order.symbol),
      this.services.now(),
      this.services.clockSkewToleranceSeconds,
    );
  }
  private modificationOptions(symbol: string, context: TradingCommandContext) {
    if (context.parent && context.parent.kind !== "order") return this.services.positionOptions?.(symbol);
    return this.services.orderOptions?.(symbol);
  }
  /** Loaded protection options for a draft that has, or edits, protection. */
  private loadProtectionOptions(order: PreOrder, context: TradingCommandContext) {
    return context.parent || hasOrderProtection(order) ? this.modificationOptions(order.symbol, context) : undefined;
  }
  async validate(request: PlaceRequest): Promise<void> {
    await this.checkDraft(snapshot(request));
  }
  /** Validation shared by validate(), preview() and modify(); returns what it loaded so callers do not ask again. */
  private async checkDraft(request: PlaceRequest) {
    const id = existingOrderId(request.order);
    this.validateModificationContext(request.context, id);
    const instrument = await this.services.symbolInfo(request.order.symbol);
    const tradable = await this.services.read(() => this.services.broker.isTradable(request.order.symbol));
    this.validateModificationContext(request.context, id);
    assertTradable(tradable);
    this.validateOrderDraft(request.order, request.context, instrument);
    const options = await this.loadProtectionOptions(request.order, request.context);
    this.validateModificationContext(request.context, id);
    if (id)
      assertOrderModification(
        this.services.state.orders.get(id),
        request.order,
        this.services.policy(request.order.symbol),
      );
    this.route(request.order, request.context, instrument, options?.maxExitLevelsCount);
    return { id, instrument, options };
  }
  async preview(request: PlaceRequest): Promise<LumenOrderPreview> {
    request = snapshot(request);
    const { id, instrument, options } = await this.checkDraft(request);
    const method = this.services.broker.previewOrder;
    if (!method) throw new TradingError("unsupported", "Order previews are unavailable.");
    const draft = id
      ? request.order
      : withDefaultDuration(request.order, this.services.policy(request.order.symbol), instrument);
    const order = this.route(draft, request.context, instrument, options?.maxExitLevelsCount).payload;
    this.validateModificationContext(request.context, id);
    const result = await this.services.read(() => method.call(this.services.broker, structuredClone(order)));
    this.validateModificationContext(request.context, id);
    const preview = snapshot(result);
    const token = this.previews.issue({
      order: snapshot(request.order),
      preparedOrder: snapshot(order),
      context: { ...request.context },
      preview,
    });
    return Object.freeze({ token, preview });
  }
  async modify(request: ModifyRequest): Promise<TradingCommandResult> {
    request = snapshot(request);
    const { broker, state, coordinator, refresh } = this.services;
    const called = request.order;
    // Shared with validate/preview: context, tradability, draft rules and the prepared payload.
    const { instrument, options } = await this.checkDraft(request);
    this.assertPreview(request, "modify");
    const maxLevels = options?.maxExitLevelsCount;
    const routed: ModificationRoute = this.route(called, request.context, instrument, maxLevels);
    const order = routed.payload as Order;
    if (routed.route === "position") {
      const { parent } = routed;
      return editTradingProtection(
        this.services,
        {
          context: {
            accountId: request.context.accountId,
            generation: request.context.generation,
            revision: request.context.parent!.revision,
          },
          id: parent.id,
          individual: parent.kind === "individualPosition",
          brackets: routed.brackets,
          sourceOrder: { id: called.id, revision: request.context.revision! },
        },
        () => {
          this.validateModificationContext(request.context, called.id);
          this.route(called, request.context, instrument, maxLevels);
          this.assertPreview(request, "modify", order);
        },
      );
    }
    const targetRevision = state.orders.revision(order.id);
    const keys = new Set([commandKeys.order(called.id), commandKeys.order(order.id)]);
    if (request.context.parent) keys.add(commandKeys.entity(request.context.parent.kind, request.context.parent.id));
    return coordinator.execute({
      keys: [...keys],
      dispatch: () => {
        this.validateModificationContext(request.context, called.id);
        const latest = this.route(called, request.context, instrument, maxLevels).payload;
        if (!equalData(order, latest))
          throw new TradingError("stale-context", "This order changed. Review its current details.");
        this.assertPreview(request, "modify", order);
        return broker.modifyOrder(structuredClone(order), request.confirmId);
      },
      match: () => {
        if (!this.currentContext(request.context)) return undefined;
        const current = state.orders.get(order.id);
        if (!current) return undefined;
        if (terminalStatuses.has(current.status)) return { outcome: "changed", entityIds: [order.id] };
        if (state.orders.revision(order.id) > targetRevision && matchesOrder(current, order, instrument))
          return { outcome: "confirmed", entityIds: [order.id] };
        return undefined;
      },
      refresh,
    });
  }
  async cancel(request: EntityRequest): Promise<TradingCommandResult> {
    const { broker, state, coordinator, refresh } = this.services;
    this.validateContext(request.context, request.id);
    const order = state.orders.get(request.id);
    if (!order || terminalStatuses.has(order.status))
      throw new TradingError("stale-context", "This order is no longer active.");
    return coordinator.execute({
      keys: [commandKeys.order(request.id)],
      dispatch: () => broker.cancelOrder(request.id),
      match: () => {
        if (!this.currentContext(request.context)) return undefined;
        const current = state.orders.get(request.id);
        if (current?.status === OrderStatus.Canceled) return { outcome: "confirmed", entityIds: [request.id] };
        if (current && terminalStatuses.has(current.status)) return { outcome: "changed", entityIds: [request.id] };
        return undefined;
      },
      refresh,
    });
  }
  async cancelMany(request: {
    context: TradingCommandContext;
    symbol: string;
    side?: Side;
    orders: readonly { id: string; revision: number }[];
  }): Promise<readonly { id: string; result?: TradingCommandResult; error?: unknown }[]> {
    this.validateContext(request.context);
    const method = this.services.broker.cancelOrders;
    if (!method) throw new TradingError("unsupported", "Bulk cancellation is unavailable.");
    if (!request.orders.length) throw new TradingError("invalid-input", "Choose at least one order.");
    for (const item of request.orders) {
      this.validateContext({ ...request.context, revision: item.revision }, item.id);
      const order = this.services.state.orders.get(item.id);
      if (
        !order ||
        terminalStatuses.has(order.status) ||
        order.symbol !== request.symbol ||
        (request.side !== undefined && order.side !== request.side)
      )
        throw new TradingError("stale-context", "The selected orders changed.");
    }
    let transportError: unknown;
    const results = await this.services.coordinator.executeBatch(
      request.orders.map((item) => ({
        keys: [commandKeys.order(item.id)],
        refresh: this.services.refresh,
        match: () => {
          if (!this.currentContext(request.context)) return undefined;
          const order = this.services.state.orders.get(item.id);
          if (order?.status === OrderStatus.Canceled) return { outcome: "confirmed" as const, entityIds: [item.id] };
          if (order?.status === OrderStatus.Filled) return { outcome: "changed" as const, entityIds: [item.id] };
          if (transportError) throw transportError;
          if (order?.status === OrderStatus.Rejected)
            throw new TradingError("broker-rejected", "The broker rejected this cancellation.");
          return undefined;
        },
      })),
      async () => {
        try {
          await method.call(
            this.services.broker,
            request.symbol,
            request.side,
            request.orders.map((item) => item.id),
          );
        } catch (cause) {
          transportError = brokerRejectionError(cause, "Some orders could not be cancelled.");
        }
      },
    );
    return results.map((result, index) =>
      result.status === "fulfilled"
        ? { id: request.orders[index].id, result: result.value }
        : { id: request.orders[index].id, error: result.reason },
    );
  }
}
