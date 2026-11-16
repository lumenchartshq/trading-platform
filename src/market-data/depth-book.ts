import type { DOMData, DOMLevel } from '../contracts/broker.js';
import { EntityStore } from '../core/entity-store.js';
import { TradingError } from '../core/errors.js';
import { snapToStep } from '../core/trading-rules.js';
export interface DepthLevel extends DOMLevel { readonly id: string; }
/** Incremental price-keyed books. Only explicit snapshot() calls materialize/sort the whole book. */
export class DepthBook {
  readonly bids = new EntityStore<DepthLevel>(() => {});
  readonly asks = new EntityStore<DepthLevel>(() => {});
  private initialized = false;
  private buffered: DOMData[] = [];
  constructor(private readonly tick: number) {}
  private normalize(levels: readonly DOMLevel[]): DepthLevel[] {
    const normalized = new Map<string, DepthLevel>();
    for (const level of levels) {
      if (!Number.isFinite(level.price) || !Number.isFinite(level.volume) || level.volume < 0) throw new TradingError('invalid-input', 'Invalid depth level.');
      const price = snapToStep(level.price, this.tick);
      normalized.set(String(price), { id: String(price), price, volume: level.volume });
    }
    return [...normalized.values()];
  }
  apply(data: DOMData): DOMData | undefined {
    // Normalize both sides before mutating either side.
    const bids = this.normalize(data.bids), asks = this.normalize(data.asks);
    if (!this.initialized && !data.snapshot) {
      this.buffered.push({ snapshot: false, bids, asks });
      if (this.buffered.length > 1000) { this.buffered = []; throw new TradingError('broker-unavailable', 'Depth needs a fresh snapshot.'); }
      return undefined;
    }
    if (data.snapshot) {
      this.initialized = true;
      // A later authoritative snapshot supersedes deltas received before it.
      this.buffered = [];
      this.bids.transaction(() => this.asks.transaction(() => {
        this.bids.replace(bids.filter(level => level.volume > 0));
        this.asks.replace(asks.filter(level => level.volume > 0));
      }));
    } else {
      for (const [store, levels] of [[this.bids, bids], [this.asks, asks]] as const) store.transaction(() => {
        for (const level of levels) { if (level.volume === 0) store.remove(level.id); else store.upsert(level); }
      });
    }
    return Object.freeze({ snapshot: data.snapshot, bids: Object.freeze(bids.sort((a, b) => a.price - b.price)), asks: Object.freeze(asks.sort((a, b) => a.price - b.price)) }) as unknown as DOMData;
  }
  snapshot(): DOMData | undefined {
    if (!this.initialized) return undefined;
    const rows = (store: EntityStore<DepthLevel>) => store.ids().map(id => store.get(id)!).sort((a, b) => a.price - b.price);
    return Object.freeze({ snapshot: true, bids: Object.freeze(rows(this.bids)), asks: Object.freeze(rows(this.asks)) }) as unknown as DOMData;
  }
  destroy(): void { this.bids.destroy(); this.asks.destroy(); this.buffered = []; }
}
