import type { Dispose } from "../contracts/ports.js";

/** Always attempt releases in insertion order, then preserve the first failure. */
export function releaseAll(releases: Iterable<Dispose>): void {
  let failed = false, first: unknown;
  for (const release of releases) {
    try { release(); }
    catch (cause) { if (!failed) first = cause; failed = true; }
  }
  if (failed) throw first;
}
interface Entry<D> { readonly value: D; readonly owners: Set<unknown>; }
/** Keyed demand with idempotent leases and optional consumer identity deduplication. */
export class KeyedRefCount<K, D> {
  private readonly entries = new Map<K, Entry<D>>();
  constructor(private readonly dispose: (value: D, key: K) => void) {}
  get(key: K): D | undefined { return this.entries.get(key)?.value; }
  *values(): IterableIterator<D> { for (const entry of this.entries.values()) yield entry.value; }
  *[Symbol.iterator](): IterableIterator<[K, D]> {
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }
  acquire(key: K, create: () => D, owner: unknown = Symbol()) {
    let entry = this.entries.get(key);
    const first = !entry;
    if (!entry) {
      entry = { value: create(), owners: new Set() };
      this.entries.set(key, entry);
    }
    const retained = entry;
    retained.owners.add(owner);
    let owned = true;
    return {
      value: retained.value,
      first,
      release: () => {
        if (!owned) return;
        owned = false;
        if (this.entries.get(key) !== retained || !retained.owners.delete(owner) || retained.owners.size) return;
        this.entries.delete(key);
        this.dispose(retained.value, key);
      },
    };
  }
  releaseAll(): void {
    const entries = [...this.entries];
    this.entries.clear();
    releaseAll(entries.map(([key, entry]) => () => this.dispose(entry.value, key)));
  }
}
