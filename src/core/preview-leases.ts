import { BoundedMap } from "./bounded-map.js";

/** Reviews are consumed only by a matching dispatch; failed checks keep them available. */
export class PreviewLeases<T> {
  private readonly leases: BoundedMap<string, T>;
  private sequence = 0;
  constructor(
    private readonly prefix: string,
    capacity = 200,
    private readonly next = () => ++this.sequence,
  ) { this.leases = new BoundedMap(capacity); }

  issue(value: T): string {
    const token = `${this.prefix}-${this.next()}`;
    this.leases.set(token, value);
    return token;
  }
  claim(token: string | undefined, matches: (value: T) => boolean, consume = true): T | undefined {
    if (!token) return undefined;
    const value = this.leases.get(token);
    if (value === undefined || !matches(value)) return undefined;
    if (consume) this.leases.delete(token);
    return value;
  }
  invalidate(predicate: (value: T) => boolean): void {
    for (const [token, value] of this.leases)
      if (predicate(value)) this.leases.delete(token);
  }
  clear(): void { this.leases.clear(); }
}
