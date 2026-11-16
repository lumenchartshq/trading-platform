interface Page<T> { start: number; sourceStart: number; keys: string[]; items?: readonly T[]; touched: number; }
/** Payload residency is bounded; compact identity/page metadata preserves scroll-back geometry. */
export class PagedListWindow<T> {
  private pages: Page<T>[] = [];
  private keys: string[] = [];
  private residents = new Set<Page<T>>();
  private identities = new Set<string>();
  private pending = new Map<number, Promise<void>>();
  private pinned = new Set<number>();
  private generation = 0;
  private tick = 0;
  constructor(private key: (item: T) => string, private load: (start: number) => Promise<readonly T[]>, private changed: () => void, private residentPages = 20) {}
  get count() { return this.keys.length; }
  keyAt(index: number) { return this.keys[index] ?? `pending:${index}`; }
  private pageAt(index: number) {
    let low = 0, high = this.pages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.pages[middle]!.start <= index) low = middle + 1; else high = middle;
    }
    return this.pages[low - 1];
  }
  at(index: number) { const page = this.pageAt(index); return page?.items?.[index - page.start]; }
  resident() { return [...this.residents].sort((a, b) => a.start - b.start).flatMap(page => page.items ?? []); }
  get residentCount() { return [...this.residents].reduce((sum, page) => sum + (page.items?.length ?? 0), 0); }
  cancel() { this.generation++; this.pending.clear(); this.pinned.clear(); }
  reset(items: readonly T[] = []) {
    this.generation++; this.pages = []; this.residents.clear(); this.keys = []; this.identities.clear(); this.pending.clear(); this.pinned.clear();
    if (items.length) {
      this.pinned.add(0);
      for (let start = 0; start < items.length; start += 50) this.append(items.slice(start, start + 50), start);
    }
  }
  append(items: readonly T[], sourceStart: number) {
    const distinct = items.filter(item => { const id = this.key(item); if (this.identities.has(id)) return false; this.identities.add(id); return true; });
    if (!distinct.length) return;
    const keys = distinct.map(this.key);
    const page = { start: this.keys.length, sourceStart, keys, items: distinct, touched: ++this.tick };
    this.pages.push(page); this.residents.add(page);
    this.keys.push(...keys); this.trim();
  }
  private trim() {
    const resident = [...this.residents];
    resident.sort((a, b) => a.touched - b.touched);
    let count = resident.length;
    for (const page of resident) if (count > this.residentPages && !this.pinned.has(page.start)) { page.items = undefined; this.residents.delete(page); count--; }
  }
  async ensure(indices: readonly number[]) {
    const pages = new Set(indices.map(index => this.pageAt(index)).filter((page): page is Page<T> => !!page));
    this.pinned = new Set([...pages].map(page => page.start));
    const epoch = this.generation;
    await Promise.all([...pages].map(async page => {
      page.touched = ++this.tick;
      if (page.items) return;
      const waiting = this.pending.get(page.start); if (waiting) return waiting;
      const request = this.load(page.sourceStart).then(items => {
        if (epoch !== this.generation) return;
        const byKey = new Map(items.map(item => [this.key(item), item]));
        const restored = page.keys.map(key => byKey.get(key));
        if (restored.some(item => !item)) throw new Error("Symbol results changed. Search again.");
        page.items = restored as T[]; this.residents.add(page);
        this.trim(); this.changed();
      }).finally(() => { if (this.pending.get(page.start) === request) this.pending.delete(page.start); });
      this.pending.set(page.start, request);
      return request;
    }));
    this.trim();
  }
}
