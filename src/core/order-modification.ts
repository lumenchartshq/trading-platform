import { orderRestrictionsField } from "../contracts/ports.js";
import { bracketParent, type BracketParentKind } from "./bracket-parent.js";
import { OrderType, StopType } from "../contracts/broker.js";
import type { Order, PreOrder } from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import { terminalStatuses } from "./entity-validation.js";
import { TradingError } from "./errors.js";
import { equalData } from "./immutable.js";

export const editableOrderFields = [
  "qty",
  "side",
  "type",
  "limitPrice",
  "stopPrice",
  "stopType",
  "stopLoss",
  "takeProfit",
  "guaranteedStop",
  "trailingStopPips",
  "duration",
  "customFields",
  "exitLevels",
] as const;
/** Both preview and dispatch enforce the same current broker and symbol permissions. */
export function assertOrderModification(
  previous: Readonly<Order> | undefined,
  order: Readonly<PreOrder>,
  policy: CapabilityPolicy,
): void {
  if (!previous || !brokerAllowsModification(previous) || terminalStatuses.has(previous.status))
    throw new TradingError(
      "stale-context",
      "This order is no longer editable.",
    );
  if (
    previous.symbol !== order.symbol ||
    previous.side !== order.side ||
    previous.type === OrderType.Market
  )
    throw new TradingError(
      "invalid-input",
      "The order identity cannot be changed.",
    );
  const child = bracketParent(previous);
  const submitted = order as Readonly<Order>;
  for (const field of [
    "id",
    "status",
    "parentId",
    "parentType",
    "exitLevelId",
  ] as const) {
    if (
      !equalData(
        previous[field as keyof Order],
        submitted[field as keyof Order],
      )
    )
      throw new TradingError(
        "invalid-input",
        "The order identity cannot be changed.",
      );
  }
  if (child && previous.type !== order.type)
    throw new TradingError(
      "invalid-input",
      "The protection order type cannot be changed.",
    );
  const brackets = bracketPermission(child?.kind, policy);
  const trailingType =
    previous.stopType === StopType.TrailingStop ||
    order.stopType === StopType.TrailingStop;
  const permissions: Partial<
    Record<(typeof editableOrderFields)[number], boolean>
  > = {
    qty: policy.flags.supportEditAmount && (!child || brackets),
    type: policy.flags.supportModifyOrderType,
    limitPrice: child ? brackets : policy.flags.supportModifyOrderPrice,
    stopPrice: child
      ? brackets && (!trailingType || policy.flags.supportModifyTrailingStop)
      : policy.flags.supportModifyOrderPrice,
    stopType:
      brackets && (!trailingType || policy.flags.supportModifyTrailingStop),
    stopLoss: brackets,
    takeProfit: brackets,
    guaranteedStop: brackets,
    trailingStopPips: brackets && policy.flags.supportModifyTrailingStop,
    exitLevels: brackets,
    duration: policy.flags.supportModifyDuration,
  };
  for (const field of editableOrderFields)
    if (
      permissions[field] === false &&
      !equalData(previous[field], order[field])
    )
      throw new TradingError(
        "unsupported",
        "This order field cannot be changed.",
      );
}

function bracketPermission(
  child: BracketParentKind | undefined,
  policy: CapabilityPolicy,
): boolean {
  if (child === "position")
    return (
      policy.flags.supportPositionBrackets &&
      policy.symbol.supportModifyPositionBrackets !== false
    );
  if (child === "individualPosition")
    return (
      policy.flags.supportIndividualPositionBrackets &&
      policy.symbol.supportModifyPositionBrackets !== false
    );
  return (
    policy.flags.supportModifyBrackets &&
    policy.symbol.supportModifyOrderBrackets !== false
  );
}

/** Which parts of an existing order a host may offer for editing; commands enforce the same rules on dispatch. */
export interface OrderEditability {
  /** Owner kind when the order is a protection child. */
  readonly protection: BracketParentKind | undefined;
  readonly price: boolean;
  readonly qty: boolean;
  readonly type: boolean;
  readonly duration: boolean;
  /** Nested TP/SL editing on a parent order. */
  readonly brackets: boolean;
  readonly trailingDistance: boolean;
}
const notEditable: OrderEditability = Object.freeze({
  protection: undefined,
  price: false,
  qty: false,
  type: false,
  duration: false,
  brackets: false,
  trailingDistance: false,
});

export function orderEditability(
  order: Readonly<Order>,
  policy: CapabilityPolicy,
  parentAvailable: boolean,
): OrderEditability {
  if (!brokerAllowsModification(order) || terminalStatuses.has(order.status) || order.type === OrderType.Market)
    return notEditable;
  const child = bracketParent(order);
  if (!child && "parentId" in order && order.parentId && !parentAvailable)
    return notEditable;
  if (child) {
    if (!parentAvailable) return notEditable;
    const brackets = bracketPermission(child.kind, policy);
    const trailing = order.stopType === StopType.TrailingStop;
    return {
      protection: child.kind,
      price: brackets && !trailing,
      qty: brackets && policy.flags.supportEditAmount,
      type: false,
      duration: false,
      brackets: false,
      trailingDistance:
        trailing && brackets && policy.flags.supportModifyTrailingStop,
    };
  }
  const brackets = bracketPermission(undefined, policy);
  return {
    protection: undefined,
    price: policy.flags.supportModifyOrderPrice,
    qty: policy.flags.supportEditAmount,
    type: policy.flags.supportModifyOrderType,
    duration: policy.flags.supportModifyDuration,
    brackets,
    trailingDistance: brackets && policy.flags.supportModifyTrailingStop,
  };
}

export function canModifyOrder(editability: OrderEditability): boolean {
  return (
    editability.price ||
    editability.qty ||
    editability.type ||
    editability.duration ||
    editability.brackets ||
    editability.trailingDistance
  );
}

/** Provider-owned metadata can restrict an order, never enable a disabled capability. */
function brokerAllowsModification(order: Readonly<Order>): boolean {
  const value: unknown = order.extra?.[orderRestrictionsField];
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return Reflect.get(value, "editable") !== false;
}
