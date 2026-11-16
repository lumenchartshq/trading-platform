import type { DOMData, Side } from "../../contracts/broker.js";
import { ValueStore } from "../../core/value-store.js";
import { valueReader } from "../../core/readers.js";
import { TradingError } from "../../core/errors.js";
import { snapToStep } from "../../core/trading-rules.js";
export interface LadderRow {
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly buyQuantity: number;
  readonly sellQuantity: number;
}
interface OwnOrder {
  readonly index: number;
  readonly side: Side;
  readonly qty: number;
}
/** Fixed keyed prices. Depth deltas only publish changed visible rows. */
export function createDepthLadder(
  tick: number,
  count = 31,
  staticMode = false,
) {
  if (
    !Number.isFinite(tick) ||
    tick <= 0 ||
    !Number.isInteger(count) ||
    count < 3 ||
    count > 201 ||
    count % 2 !== 1
  )
    throw new TradingError("invalid-input", "Invalid depth viewport.");
  const bids = new Map<number, number>(),
    asks = new Map<number, number>();
  const orders = new Map<string, OwnOrder>();
  const quantities = new Map<number, { buy: number; sell: number }>();
  const rows = new Map<number, ValueStore<LadderRow>>();
  const viewport = new ValueStore<readonly number[]>([]);
  let center: number | undefined,
    last: number | undefined,
    actions = 0,
    disposed = false;
  function index(price: number): number {
    if (!Number.isFinite(price))
      throw new TradingError("invalid-input", "Invalid depth price.");
    const result = Math.round(price / tick);
    if (!Number.isSafeInteger(result))
      throw new TradingError(
        "invalid-input",
        "Depth price exceeds supported precision.",
      );
    return result;
  }
  const rowValue = (key: number): LadderRow =>
    Object.freeze({
      price: snapToStep(key * tick, tick),
      bid: bids.get(key) ?? 0,
      ask: asks.get(key) ?? 0,
      buyQuantity: quantities.get(key)?.buy ?? 0,
      sellQuantity: quantities.get(key)?.sell ?? 0,
    });
  const publish = (key: number) => rows.get(key)?.set(rowValue(key));
  function recenter(
    price = last === undefined ? undefined : last * tick,
  ): boolean {
    if (disposed || actions || price === undefined) return false;
    const next = index(price);
    if (center === next) return true;
    center = next;
    const half = (count - 1) / 2;
    const keys = Array.from(
      { length: count },
      (_, offset) => next + half - offset,
    );
    const retained = new Set(keys);
    for (const [key, row] of rows)
      if (!retained.has(key)) {
        row.destroy();
        rows.delete(key);
      }
    for (const key of keys)
      if (!rows.has(key)) rows.set(key, new ValueStore(rowValue(key)));
    viewport.set(Object.freeze(keys));
    return true;
  }
  function maybeRecenter(): void {
    if (
      last !== undefined &&
      (center === undefined || (!staticMode && !rows.has(last)))
    )
      recenter(last * tick);
  }
  return {
    viewport: valueReader(viewport),
    row(key: number) {
      const row = rows.get(key);
      return row ? valueReader(row) : undefined;
    },
    lastPrice(price: number): void {
      if (disposed) return;
      last = index(price);
      maybeRecenter();
    },
    recenter,
    apply(data: DOMData): void {
      if (disposed) return;
      const normalize = (levels: DOMData["bids"]) =>
        levels.map((level) => {
          if (!Number.isFinite(level.volume) || level.volume < 0)
            throw new TradingError("invalid-input", "Invalid depth volume.");
          return { key: index(level.price), volume: level.volume };
        });
      const bidLevels = normalize(data.bids),
        askLevels = normalize(data.asks);
      const changed = new Set<number>();
      if (data.snapshot) {
        bids.clear();
        asks.clear();
        for (const key of rows.keys()) changed.add(key);
      }
      for (const [levels, side] of [
        [bidLevels, bids],
        [askLevels, asks],
      ] as const)
        for (const level of levels) {
          if (
            side.get(level.key) === level.volume ||
            (!side.has(level.key) && level.volume === 0)
          )
            continue;
          if (level.volume === 0) side.delete(level.key);
          else side.set(level.key, level.volume);
          changed.add(level.key);
        }
      for (const key of changed) publish(key);
    },
    order(id: string, side: Side, price: number, qty: number): void {
      if (disposed) return;
      if ((side !== 1 && side !== -1) || !Number.isFinite(qty) || qty < 0)
        throw new TradingError("invalid-input", "Invalid order annotation.");
      const key = index(price),
        old = orders.get(id),
        affected = new Set([key]);
      const adjust = (order: OwnOrder, direction: number) => {
        const values = quantities.get(order.index) ?? { buy: 0, sell: 0 };
        if (order.side === 1) values.buy += direction * order.qty;
        else values.sell += direction * order.qty;
        if (values.buy === 0 && values.sell === 0) quantities.delete(order.index);
        else quantities.set(order.index, values);
      };
      if (old) {
        adjust(old, -1);
        affected.add(old.index);
      }
      if (qty === 0) orders.delete(id);
      else {
        const next = { index: key, side, qty };
        orders.set(id, next);
        adjust(next, 1);
      }
      for (const changed of affected) publish(changed);
    },
    beginAction(key: number) {
      const row = rows.get(key);
      if (disposed || !row)
        throw new TradingError("stale-context", "This depth row changed.");
      actions++;
      let owned = true;
      return Object.freeze({
        price: row.get().price,
        release() {
          if (!owned) return;
          owned = false;
          actions--;
          if (!disposed) maybeRecenter();
        },
      });
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      for (const row of rows.values()) row.destroy();
      rows.clear();
      bids.clear();
      asks.clear();
      orders.clear();
      quantities.clear();
      viewport.destroy();
    },
  };
}
export function formatDepthVolume(
  value: number,
  raw: boolean,
  locale = "en",
): string {
  return new Intl.NumberFormat(locale, {
    notation: raw ? "standard" : "compact",
    maximumFractionDigits: 8,
  }).format(value);
}
