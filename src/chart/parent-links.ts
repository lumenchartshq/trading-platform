import type { IndividualPosition, Order, Position, TradingQuotes } from "../contracts/broker.js";
import type { TradingOverlaySpec } from "../contracts/ports.js";
import type { EntityReader } from "../core/entity-store.js";
import { entityEntryPrice, orderEntryPrice } from "../core/financial-rules.js";
import { bracketParent } from "../core/bracket-parent.js";
import { completeParentProtection } from "../core/parent-protection.js";
import { childProtectionField, type ProtectionField } from "../core/protection-legs.js";
import type { createBracketLinks } from "./bracket-links.js";
import type { OverlayEntityKind } from "./overlay-projection.js";

type ParentKind = "order" | "position" | "individualPosition";
export interface ParentLinkSources {
  readonly stores: {
    readonly order: EntityReader<Order>;
    readonly position: EntityReader<Position>;
    readonly individualPosition: EntityReader<IndividualPosition>;
  };
  readonly quotes: Pick<EntityReader<TradingQuotes & { id: string }>, "get">;
  readonly links: ReturnType<typeof createBracketLinks>;
  readonly keyFor: (kind: OverlayEntityKind, id: string) => string;
}

/** Parent/child exit relationships as chart overlays read them; pure over the given stores and links. */
export function createParentLinks({ stores, quotes, links, keyFor }: ParentLinkSources) {
  /** Parent with its broker child legs folded in, as a protection edit starts from. */
  function completedParent(kind: ParentKind, id: string) {
    const parent = stores[kind].get(id);
    const children = links
      .children(keyFor(kind, id))
      .map((child) => stores.order.get(child))
      .filter((child): child is Readonly<Order> => !!child);
    return parent && children.length
      ? completeParentProtection<Order | Position | IndividualPosition>(parent, children)
      : parent;
  }
  /**
   * The parent protection a confirmed TP/SL exit edits when dragged by its body: its broker level when the
   * exit belongs to an allocated level, otherwise the parent's single TP/SL pair.
   */
  function confirmedExitParent(
    spec: Pick<TradingOverlaySpec, "kind" | "protection">,
    kind: OverlayEntityKind,
    id: string,
  ) {
    const leg = spec.protection?.movingLeg;
    if (kind !== "order" || spec.kind !== "bracket" || !leg) return undefined;
    const order = stores.order.get(id);
    const parent = order ? bracketParent(order) : undefined;
    if (!order || !parent) return undefined;
    const completed = completedParent(parent.kind, parent.id);
    // Brokers may tag a single TP/SL pair with a level ID too; only a parent that reports allocated
    // levels has a level to move, otherwise the drag edits the parent's single pair.
    const levelId = "parentId" in order ? order.exitLevelId : undefined;
    const level =
      levelId !== undefined && completed?.exitLevels?.some((value) => value.id === levelId) ? levelId : undefined;
    return { kind: parent.kind, id: parent.id, leg, completed, ...(level !== undefined ? { level } : {}) };
  }
  /** Price a parent's exits measure from; a waiting market order uses the price it would fill at now. */
  function exitEntryPrice(kind: ParentKind, parent: Readonly<Order | Position | IndividualPosition>) {
    if (kind !== "order") return entityEntryPrice(kind, parent);
    return orderEntryPrice(parent as Order, quotes.get(parent.symbol));
  }
  /** Legs the active child orders of a parent provide, for brokers that report protection only as children. */
  function childLegs(parentKey: string): ReadonlySet<ProtectionField> {
    const legs = new Set<ProtectionField>();
    for (const child of links.children(parentKey)) {
      const order = stores.order.get(child);
      const field = order ? childProtectionField(order) : undefined;
      if (field) legs.add(field);
    }
    return legs;
  }
  return { completedParent, confirmedExitParent, exitEntryPrice, childLegs };
}
