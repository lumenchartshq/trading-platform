/** Least-recently-used retention: reads and writes both refresh recency; replacing a key never evicts an unrelated entry. */
export class BoundedMap<K, V> {
  private readonly values = new Map<K, V>();
  constructor(private readonly capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("A bounded map needs a positive integer capacity.");
  }
  get size(): number { return this.values.size; }
  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    // Re-insert so symbols in active use are never the eviction victim.
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }
  set(key: K, value: V): void {
    if (!this.values.has(key) && this.values.size >= this.capacity)
      this.values.delete(this.values.keys().next().value!);
    this.values.set(key, value);
  }
  delete(key: K): boolean { return this.values.delete(key); }
  clear(): void { this.values.clear(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.values[Symbol.iterator](); }
}
