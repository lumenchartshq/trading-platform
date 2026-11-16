import type {
  Brackets,
  IndividualPosition,
  InstrumentInfo,
  Order,
  Position,
  PreOrder,
  TradingQuotes,
} from "../contracts/broker.js";
import type { CapabilityPolicy } from "./capabilities.js";
import type { TradingState } from "./trading-state.js";
import type { ModificationParentContext } from "./modification-context.js";
import { assertModificationParent } from "./modification-context.js";
import { activeProtectionChildren } from "./bracket-parent.js";
import { completeParentProtection } from "./parent-protection.js";
import { protectionFromChildEdit } from "./bracket-modification.js";
import { assertOrderModification } from "./order-modification.js";
import { prepareOrderProtection } from "./order-protection.js";
import { validatePositionProtection } from "./protection-rules.js";

/** ID of the working order a draft modifies; undefined for new placements. */
export function existingOrderId(order: PreOrder): string | undefined {
  return "id" in order && typeof order.id === "string" ? order.id : undefined;
}

export type ModificationParent = NonNullable<ReturnType<typeof assertModificationParent>>;

/** A parent with its active child legs folded in, as a child edit starts from. */
export function protectionOwner(state: TradingState, parent: ModificationParent) {
  const children = activeProtectionChildren(state.orders, parent.kind, parent.id);
  return completeParentProtection<typeof parent.value>(parent.value, children);
}

export interface ModificationInput {
  readonly state: TradingState;
  readonly order: PreOrder;
  readonly parentContext?: ModificationParentContext;
  readonly policy: CapabilityPolicy;
  readonly instrument: InstrumentInfo;
  readonly quotes?: TradingQuotes;
  readonly maxLevels?: number;
  /** `always_pass_called_order_to_modify`: send the edited child itself rather than its parent. */
  readonly passCalledOrder?: boolean;
}

/**
 * Where a draft goes and what is sent:
 * - `plain`: a new order or an order edited directly; the payload has normalised protection.
 * - `order`: a child exit of a parent order; the parent (or, with `passCalledOrder`, the child) is modified.
 * - `position`: a child exit of a position; the position's protection is edited with `brackets`.
 */
export type ModificationRoute =
  | { readonly route: "plain"; readonly payload: PreOrder }
  | { readonly route: "order"; readonly payload: PreOrder; readonly parent: ModificationParent }
  | {
      readonly route: "position";
      readonly payload: PreOrder;
      readonly parent: ModificationParent;
      /** The protection the child edit asks for, before normalisation (sent through the position path). */
      readonly brackets: Brackets;
    };

/** Validates a draft against current state and decides its route. Pure over the given state snapshot. */
export function routeModification(input: ModificationInput): ModificationRoute {
  const { state, order, policy, instrument, quotes, maxLevels } = input;
  const id = existingOrderId(order);
  const previous = id ? state.orders.get(id) : undefined;
  if (id) assertOrderModification(previous, order, policy);
  const parent = previous && assertModificationParent(state, previous, input.parentContext);
  if (parent?.kind === "order") {
    const source = protectionOwner(state, parent) as Readonly<Order>;
    const brackets = protectionFromChildEdit(source, previous!, order as Order);
    const updated = prepareOrderProtection({ ...source, ...brackets }, instrument, policy, quotes, maxLevels, source);
    assertOrderModification(source, updated, policy);
    return { route: "order", payload: input.passCalledOrder ? order : updated, parent };
  }
  if (parent) {
    const brackets = protectionFromChildEdit(protectionOwner(state, parent), previous!, order as Order);
    const position = parent.value as Readonly<Position | IndividualPosition>;
    validatePositionProtection(
      position,
      brackets,
      instrument,
      policy,
      state.quotes.get(position.symbol),
      maxLevels,
      parent.kind === "individualPosition",
    );
    return { route: "position", payload: order, parent, brackets };
  }
  return { route: "plain", payload: prepareOrderProtection(order, instrument, policy, quotes, maxLevels, previous) };
}
