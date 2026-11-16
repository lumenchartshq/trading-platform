import { OrderType } from "../contracts/broker.js";
import type { Order } from "../contracts/broker.js";
import type { OverlayEntityKind, Projection } from "./overlay-projection.js";

/**
 * Symbol-keyed indexes over the current projections, so quote, pip and finance work stays proportional to the
 * affected symbol: projections by symbol, the symbol each key was last indexed under, exit orders and position
 * counts per symbol, and waiting market parents per symbol. Pure; owns no subscriptions.
 */
export class OverlayIndex {
  private readonly bySymbol = new Map<string, Map<string, Projection>>();
  private readonly previousSymbol = new Map<string, string>();
  private readonly exitsBySymbol = new Map<string, Set<string>>();
  private readonly positionCounts = new Map<string, number>();
  private readonly marketParentsBySymbol = new Map<string, Set<string>>();
  private readonly marketParentSymbol = new Map<string, string>();

  /** Records the projection for `key` (or its removal) and returns the symbol it was indexed under before. */
  set(kind: OverlayEntityKind, id: string, key: string, projection: Projection | undefined): string | undefined {
    const oldSymbol = this.previousSymbol.get(key);
    const position = kind === "position" || kind === "individualPosition";
    if (oldSymbol) {
      if (kind === "order") removeFromSet(this.exitsBySymbol, oldSymbol, id);
      const projections = this.bySymbol.get(oldSymbol);
      if (projections?.delete(key) && position) this.countPosition(oldSymbol, -1);
      if (projections && !projections.size) this.bySymbol.delete(oldSymbol);
    }
    this.previousSymbol.delete(key);
    if (!projection) return oldSymbol;
    const symbol = projection.spec.symbol;
    let projections = this.bySymbol.get(symbol);
    if (!projections) this.bySymbol.set(symbol, (projections = new Map()));
    projections.set(key, projection);
    if (position) this.countPosition(symbol, 1);
    this.previousSymbol.set(key, symbol);
    if (projection.spec.kind === "bracket") addToSet(this.exitsBySymbol, symbol, id);
    return oldSymbol;
  }
  /** Projections currently indexed for a symbol, keyed by overlay key. */
  projections(symbol: string): ReadonlyMap<string, Projection> {
    return this.bySymbol.get(symbol) ?? EMPTY;
  }
  /** IDs of an entity kind still indexed, including ones whose entity has since gone. */
  indexedIds(kind: OverlayEntityKind): string[] {
    const prefix = `${kind}:`;
    return [...this.previousSymbol.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
  exitIds(symbol: string): ReadonlySet<string> {
    return this.exitsBySymbol.get(symbol) ?? EMPTY_SET;
  }
  hasExits(symbol: string): boolean {
    return !!this.exitsBySymbol.get(symbol)?.size;
  }
  hasPositions(symbol: string): boolean {
    return this.positionCounts.has(symbol);
  }
  /** Tracks orders that are waiting market orders: their exits follow the quote. */
  indexMarketParent(id: string, order: Readonly<Order> | undefined): void {
    const symbol = order?.type === OrderType.Market ? order.symbol : undefined;
    const previous = this.marketParentSymbol.get(id);
    if (previous === symbol) return;
    if (previous !== undefined) {
      removeFromSet(this.marketParentsBySymbol, previous, id);
      this.marketParentSymbol.delete(id);
    }
    if (symbol === undefined) return;
    addToSet(this.marketParentsBySymbol, symbol, id);
    this.marketParentSymbol.set(id, symbol);
  }
  marketParents(symbol: string): ReadonlySet<string> {
    return this.marketParentsBySymbol.get(symbol) ?? EMPTY_SET;
  }
  clearMarketParents(): void {
    this.marketParentsBySymbol.clear();
    this.marketParentSymbol.clear();
  }
  clear(): void {
    this.bySymbol.clear();
    this.previousSymbol.clear();
    this.exitsBySymbol.clear();
    this.positionCounts.clear();
    this.clearMarketParents();
  }
  private countPosition(symbol: string, delta: number): void {
    const next = (this.positionCounts.get(symbol) ?? 0) + delta;
    if (next > 0) this.positionCounts.set(symbol, next);
    else this.positionCounts.delete(symbol);
  }
}
const EMPTY: ReadonlyMap<string, Projection> = new Map();
const EMPTY_SET: ReadonlySet<string> = new Set();
function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}
function removeFromSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (!set.size) map.delete(key);
}
