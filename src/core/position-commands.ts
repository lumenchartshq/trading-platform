import { positionCustomMatches, validatePositionCustomFields } from "./position-custom-fields.js";
import { expectedProtectionLegs, matchesProtectionLegs } from "./protection-legs.js";
import { commandKeys } from "./command-keys.js";
import {
  assertLiveContext,
  assertRevision,
  entityStore,
  isLiveContext,
  type AccountContext,
} from "./command-context.js";
import { terminalStatuses } from "./entity-validation.js";
import { oppositeSide } from "./financial-rules.js";
import { ParentType } from "../contracts/broker.js";
import { OrderType } from "../contracts/broker.js";
import type {
  Brackets,
  IBrokerTerminal,
  InstrumentInfo,
  Order,
  TradingDialogOptions,
} from "../contracts/broker.js";
import type { LumenBrokerExtensions } from "../contracts/ports.js";
import type { CapabilityPolicy } from "./capabilities.js";
import type { TradingState } from "./trading-state.js";
import type {
  CommandCoordinator,
  TradingCommandResult,
} from "./command-coordinator.js";
import { TradingError } from "./errors.js";
import { validateQuantity } from "./trading-rules.js";
import { protectionUnchanged, validatePositionProtection } from "./protection-rules.js";
export interface PositionContext extends AccountContext {
  readonly revision?: number;
}
export interface PositionRequest {
  readonly context: PositionContext;
  readonly id: string;
  readonly individual?: boolean;
  /** Private command dependency for an edit initiated on a broker-owned bracket row. */
  readonly sourceOrder?: { readonly id: string; readonly revision: number };
}
export interface CloseRequest extends PositionRequest {
  readonly amount?: number;
  readonly confirmId?: string;
  readonly previewToken?: string;
}
export interface ProtectionRequest extends PositionRequest {
  readonly brackets: Brackets;
  /** Broker-specific position fields; confirmed through Position.extra using the field IDs. */
  readonly customFields?: Readonly<Record<string, unknown>>;
}
export interface PositionCommandServices {
  readonly broker: IBrokerTerminal;
  readonly state: TradingState;
  readonly coordinator: CommandCoordinator;
  readonly policy: (symbol?: string) => CapabilityPolicy;
  readonly symbolInfo: (symbol: string) => Promise<InstrumentInfo>;
  readonly extensions?: LumenBrokerExtensions;
  readonly positionOptions?: (
    symbol: string,
  ) => Promise<TradingDialogOptions | undefined>;
  readonly refresh: () => void;
  readonly refreshPositions?: () => Promise<void>;
  readonly beginProtectionNotifications?: (
    context: AccountContext,
    parentType: ParentType,
    id: string,
    previous: readonly Readonly<Order>[],
  ) => (confirmed: readonly Readonly<Order>[] | undefined) => void;
}
function sources(services: PositionCommandServices, request: PositionRequest) {
  assertLiveContext(services.state, request.context);
  const kind = request.individual ? "individualPosition" : "position";
  const store = entityStore(services.state, kind);
  const position = store.get(request.id);
  if (!position || position.qty <= 0)
    throw TradingError.positionChanged();
  assertRevision(services.state, kind, request.id, request.context.revision);
  if (request.sourceOrder) {
    const source = services.state.orders.get(request.sourceOrder.id);
    if (
      !source ||
      !("parentId" in source) ||
      source.parentId !== request.id ||
      source.parentType !==
        (request.individual
          ? ParentType.IndividualPosition
          : ParentType.Position) ||
      source.symbol !== position.symbol ||
      source.side !== -position.side ||
      services.state.orders.revision(source.id) !==
        request.sourceOrder.revision ||
      terminalStatuses.has(source.status)
    )
      throw new TradingError(
        "stale-context",
        "This protection order changed. Review its current details.",
      );
  }
  return { store, position, policy: services.policy(position.symbol) };
}
/** The account is still live and the broker has reported a newer position revision than the request saw. */
function advancedSinceRequest(
  services: PositionCommandServices,
  store: { revision(id: string): number },
  request: PositionRequest,
): boolean {
  return (
    isLiveContext(services.state, request.context) &&
    store.revision(request.id) > (request.context.revision ?? 0)
  );
}
export async function closeTradingPosition(
  services: PositionCommandServices,
  request: CloseRequest,
  previewApproved = false,
  consumePreview: () => void = () => {},
): Promise<TradingCommandResult> {
  let selected = sources(services, request);
  const instrument = await services.symbolInfo(selected.position.symbol);
  selected = sources(services, request);
  const { position, store, policy } = selected;
  if ("canBeClosed" in position && position.canBeClosed === false)
    throw new TradingError("unsupported", "This position cannot be closed.");
  const amount = request.amount ?? position.qty;
  const native = request.individual
    ? policy.flags.supportCloseIndividualPosition
    : policy.flags.supportClosePosition;
  if (!native || amount !== position.qty) validateQuantity(amount, instrument.qty);
  if (amount > position.qty)
    throw new TradingError(
      "invalid-input",
      "The close quantity exceeds this position.",
    );
  const partial = amount < position.qty;
  if (
    partial &&
    !(request.individual
      ? policy.flags.supportPartialCloseIndividualPosition
      : policy.flags.supportPartialClosePosition)
  )
    throw new TradingError("unsupported", "Partial closing is unavailable.");
  if (request.individual && policy.flags.requiresFIFOCloseIndividualPositions) {
    const individual = services.state.individualPositions.get(request.id)!;
    const earlier = services.state.individualPositions.ids().some((id) => {
      // Opening times are validated at intake, so every stored individual position has one.
      const other = services.state.individualPositions.get(id)!;
      return (
        other.symbol === individual.symbol &&
        other.side === individual.side &&
        other.date < individual.date
      );
    });
    if (earlier)
      throw new TradingError(
        "unsupported",
        "Close the earliest position first.",
      );
  }
  if (request.individual && !native)
    throw new TradingError(
      "unsupported",
      "Individual position closing is unavailable.",
    );
  if (
    policy.diagnostics.some(
      (item) => item.capability === "supportPreviewClosePosition",
    )
  )
    throw new TradingError(
      "configuration",
      "Closing needs a broker preview integration.",
    );
  if (native && policy.flags.supportPreviewClosePosition && !previewApproved)
    throw new TradingError(
      "invalid-input",
      "Review the closing information first.",
    );
  const remaining = position.qty - amount;
  return services.coordinator.execute({
    keys: [
      commandKeys.position(request.id, request.individual),
      ...(!native
        ? [commandKeys.place(request.context.accountId, position.symbol)]
        : []),
    ],
    dispatch: async () => {
      consumePreview();
      if (request.individual)
        await services.broker.closeIndividualPosition!(
          request.id,
          amount,
          request.confirmId,
        );
      else if (native)
        await services.broker.closePosition!(
          request.id,
          amount,
          request.confirmId,
        );
      else
        await services.broker.placeOrder({
          symbol: position.symbol,
          side: oppositeSide(position.side),
          type: OrderType.Market,
          qty: amount,
          isClose: true,
        });
    },
    match: () => {
      if (!advancedSinceRequest(services, store, request)) return undefined;
      const latest = store.get(request.id);
      if (
        (!latest && remaining === 0) ||
        (latest?.qty === remaining && latest.side === position.side)
      )
        return { outcome: "confirmed", entityIds: [request.id] };
      if (
        !latest ||
        latest.qty !== position.qty ||
        latest.side !== position.side
      )
        return { outcome: "changed", entityIds: [request.id] };
      return undefined;
    },
    refresh: services.refresh,
  });
}
export async function reverseTradingPosition(
  services: PositionCommandServices,
  request: PositionRequest,
): Promise<TradingCommandResult> {
  const unavailable = () =>
    new TradingError("unsupported", "Reversing this position is unavailable.");
  if (request.individual) throw unavailable();
  // Symbol-specific options (supportReversePosition) load with the instrument, so decide after it.
  const instrument = await services.symbolInfo(
    sources(services, request).position.symbol,
  );
  const selected = sources(services, request),
    { position, store, policy } = selected;
  if (!policy.flags.supportReversePosition) throw unavailable();
  const native = policy.flags.supportNativeReversePosition;
  if (!native && policy.flags.supportMultiposition)
    throw new TradingError(
      "unsupported",
      "This position mode needs native broker reversing.",
    );
  if (!native) validateQuantity(position.qty * 2, instrument.qty);
  const existingIds = new Set(store.ids());
  const candidates = new Map<string, Readonly<{ id: string }>>();
  let refreshed = false;
  const release = store.subscribeChanges((change) => {
    for (const id of [...change.added, ...change.updated, ...change.removed]) {
      if (existingIds.has(id)) continue;
      const value = store.get(id);
      if (
        value &&
        value.symbol === position.symbol &&
        value.side === oppositeSide(position.side) &&
        value.qty === position.qty
      )
        candidates.set(id, value);
      else candidates.delete(id);
    }
  });
  return services.coordinator.execute({
    keys: [
      commandKeys.position(request.id),
      ...(!native
        ? [commandKeys.place(request.context.accountId, position.symbol)]
        : []),
    ],
    dispatch: async () => {
      if (native) await services.broker.reversePosition!(request.id);
      else
        await services.broker.placeOrder({
          symbol: position.symbol,
          side: oppositeSide(position.side),
          type: OrderType.Market,
          qty: position.qty * 2,
          isClose: true,
        });
      const latest = store.get(request.id);
      if (
        isLiveContext(services.state, request.context) &&
        services.refreshPositions &&
        !(
          latest?.side === oppositeSide(position.side) &&
          latest.qty === position.qty
        )
      ) {
        try {
          await services.refreshPositions();
          refreshed = true;
        } catch {
          /* Acceptance remains unconfirmed until authoritative reconciliation. */
        }
      }
    },
    match: () => {
      if (!advancedSinceRequest(services, store, request)) return undefined;
      const latest = store.get(request.id);
      if (
        latest?.side === oppositeSide(position.side) &&
        latest.qty === position.qty
      )
        return { outcome: "confirmed", entityIds: [request.id] };
      if (!latest && refreshed && candidates.size === 1) {
        const replacement = candidates.values().next().value!;
        return {
          outcome: "confirmed",
          entityIds: [request.id, replacement.id],
        };
      }
      if (latest && latest.qty !== position.qty)
        return { outcome: "changed", entityIds: [request.id] };
      return undefined;
    },
    refresh: services.refresh,
    dispose: release,
  });
}
export async function editTradingProtection(
  services: PositionCommandServices,
  request: ProtectionRequest,
  beforeDispatch?: () => void,
): Promise<TradingCommandResult> {
  const requestedFields = request.customFields === undefined ? undefined : structuredClone(request.customFields);
  const symbol = sources(services, request).position.symbol;
  const instrument = await services.symbolInfo(symbol);
  sources(services, request);
  const options = await services.positionOptions?.(symbol);
  const { position, store, policy } = sources(services, request);
  const quotes = () => services.state.quotes.get(position.symbol);
  const brackets = validatePositionProtection(
    position,
    request.brackets,
    instrument,
    policy,
    quotes(),
    options?.maxExitLevelsCount,
    !!request.individual,
  );
  if (request.individual && requestedFields && Object.keys(requestedFields).length)
    throw new TradingError("unsupported", "Custom protection fields require a net position.");
  const fields = options?.customFields ?? [];
  const validatedFields = validatePositionCustomFields(requestedFields, fields, position.extra);
  // Custom fields configure protection legs. A request that leaves none has nothing for them to apply to,
  // and brokers drop those settings with the protection, so they are neither sent nor confirmed.
  const customFields = expectedProtectionLegs(brackets, position.qty).length ? validatedFields : undefined;
  const protectionChanged = !protectionUnchanged(position, brackets);
  if (!protectionChanged && positionCustomMatches(customFields, position.extra))
    throw new TradingError(
      "invalid-input",
      "There are no protection changes to send.",
    );
  const children = new Map<string, Readonly<Order>>();
  const parentType = request.individual
    ? ParentType.IndividualPosition
    : ParentType.Position;
  const belongs = (order: Readonly<Order>) =>
    "parentId" in order &&
    order.parentId === request.id &&
    order.parentType === parentType;
  const active = (order: Readonly<Order>) =>
    !terminalStatuses.has(order.status);
  for (const id of services.state.orders.ids()) {
    const child = services.state.orders.get(id)!;
    if (belongs(child) && active(child)) children.set(id, child);
  }
  const originalChildren = children.size;
  let observedChildren = false;
  const release = services.state.orders.subscribeChanges((change) => {
    for (const id of [...change.added, ...change.updated, ...change.removed]) {
      const child = services.state.orders.get(id);
      if (children.has(id) || (child && belongs(child)))
        observedChildren = true;
      if (child && belongs(child) && active(child)) children.set(id, child);
      else children.delete(id);
    }
  });
  const expected = expectedProtectionLegs(brackets, position.qty);
  let finishNotifications: ReturnType<NonNullable<PositionCommandServices["beginProtectionNotifications"]>> | undefined;
  let matchedChildren: readonly Readonly<Order>[] | undefined;
  let confirmedChildren: readonly Readonly<Order>[] | undefined;
  try {
    const result = await services.coordinator.execute({
      keys: [
        commandKeys.position(request.id, request.individual),
        ...(request.sourceOrder ? [commandKeys.order(request.sourceOrder.id)] : []),
      ],
      dispatch: async () => {
        const latest = sources(services, request);
        validatePositionProtection(
          latest.position,
          brackets,
          instrument,
          latest.policy,
          services.state.quotes.get(latest.position.symbol),
          options?.maxExitLevelsCount,
          !!request.individual,
        );
        validatePositionCustomFields(customFields, fields, latest.position.extra);
        beforeDispatch?.();
        if (children.size)
          finishNotifications = services.beginProtectionNotifications?.(
            request.context, parentType, request.id, [...children.values()],
          );
        if (request.individual)
          await services.broker.editIndividualPositionBrackets!(
            request.id,
            brackets,
          );
        else if (customFields !== undefined) await services.broker.editPositionBrackets!(request.id, brackets, customFields);
        else await services.broker.editPositionBrackets!(request.id, brackets);
      },
      match: (_response, accepted) => {
        if (!advancedSinceRequest(services, store, request)) return undefined;
        const latest = store.get(request.id);
        if (!latest) return { outcome: "changed", entityIds: [request.id] };
        if (!protectionUnchanged(latest, brackets) || !positionCustomMatches(customFields, latest.extra)) return undefined;
        const linked = [...children.values()];
        if (protectionChanged && (expected.length || originalChildren) && !observedChildren)
          return undefined;
        if (!matchesProtectionLegs(linked, expected)) return undefined;
        if (accepted) matchedChildren = linked;
        return { outcome: "confirmed", entityIds: [request.id] };
      },
      refresh: services.refresh,
      dispose: release,
    });
    if (result.outcome === "confirmed") confirmedChildren = matchedChildren;
    return result;
  } finally {
    finishNotifications?.(confirmedChildren);
  }
}
