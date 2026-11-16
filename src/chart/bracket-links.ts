import { terminalStatuses } from "../core/entity-validation.js";
import { bracketParent } from "../core/bracket-parent.js";
import type { Order } from "../contracts/broker.js";
/** Retains orphan links so a later parent arrival touches only its own children. */
export function createBracketLinks() {
  const parentByChild = new Map<string, string>(),
    childrenByParent = new Map<string, Set<string>>();
  return {
    update(id: string, order?: Readonly<Order>): void {
      const previous = parentByChild.get(id),
        next =
          order && !terminalStatuses.has(order.status)
            ? bracketParent(order)?.key
            : undefined;
      if (previous === next) return;
      if (previous) {
        const children = childrenByParent.get(previous);
        children?.delete(id);
        if (!children?.size) childrenByParent.delete(previous);
        parentByChild.delete(id);
      }
      if (!next) return;
      let children = childrenByParent.get(next);
      if (!children) {
        children = new Set();
        childrenByParent.set(next, children);
      }
      children.add(id);
      parentByChild.set(id, next);
    },
    parentOf(childId: string): string | undefined {
      return parentByChild.get(childId);
    },
    children(parentKey: string): readonly string[] {
      return [...(childrenByParent.get(parentKey) ?? [])];
    },
    clear(): void {
      parentByChild.clear();
      childrenByParent.clear();
    },
  };
}
