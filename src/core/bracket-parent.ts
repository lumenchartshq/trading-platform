import type { EntityReader } from "./entity-store.js";
import { terminalStatuses } from "./entity-validation.js";
import { commandKeys, type CommandEntityKind } from "./command-keys.js";
import { ParentType } from "../contracts/broker.js";
import type { Order } from "../contracts/broker.js";
export type BracketParentKind = CommandEntityKind;
export function bracketParent(
  order: Readonly<Order>,
): { kind: BracketParentKind; id: string; key: string } | undefined {
  if (
    !("parentId" in order) ||
    !order.parentId ||
    (order.parentType === ParentType.Order && order.parentId === order.id)
  )
    return undefined;
  let kind: BracketParentKind;
  if (order.parentType === ParentType.Order) kind = "order";
  else if (order.parentType === ParentType.Position) kind = "position";
  else if (order.parentType === ParentType.IndividualPosition) kind = "individualPosition";
  else return undefined;
  return { kind, id: order.parentId, key: commandKeys.entity(kind, order.parentId) };
}
/** Live child orders protecting one parent; parent ID and parent type must both match. */
export function activeProtectionChildren(
  orders: Pick<EntityReader<Order>, "ids" | "get">,
  kind: BracketParentKind,
  id: string,
): Readonly<Order>[] {
  const key = commandKeys.entity(kind, id);
  const children: Readonly<Order>[] = [];
  for (const childId of orders.ids()) {
    const child = orders.get(childId);
    if (child && !terminalStatuses.has(child.status) && bracketParent(child)?.key === key) children.push(child);
  }
  return children;
}
