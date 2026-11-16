import type { Dispose } from "../contracts/ports.js";
import { equalData, snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";
export interface EntityChange {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
  readonly revision: number;
}
export interface EntityReader<T> {
  ids(): readonly string[];
  get(id: string): Readonly<T> | undefined;
  revision(id: string): number;
  subscribeChanges(listener: (change: EntityChange) => void): Dispose;
}
/** Keyed immutable state: a single update never scans or copies unrelated entities. */
/** A snapshot row the store refused; its ID (when readable) keeps its previous value. */
export interface QuarantinedRow {
  readonly id?: string;
  readonly message: string;
}
export class EntityStore<T extends { id: string }> implements EntityReader<T> {
  private readonly entities = new Map<string, Readonly<T>>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(change: EntityChange) => void>();
  private readonly before = new Map<string, Readonly<T> | undefined>();
  private idsSnapshot: readonly string[] | undefined;
  private sequence = 0;
  private depth = 0;
  private disposed = false;
  constructor(
    private readonly validate: (entity: T) => void,
    private readonly accept: (
      next: T,
      old: Readonly<T> | undefined,
    ) => boolean = () => true,
  ) {}
  ids(): readonly string[] {
    return (this.idsSnapshot ??= Object.freeze([...this.entities.keys()]));
  }
  get(id: string): Readonly<T> | undefined {
    return this.entities.get(id);
  }
  // Missing identities share a conservative watermark; deleted IDs never need permanent tombstones.
  revision(id: string): number {
    return this.revisions.get(id) ?? this.sequence;
  }
  subscribeChanges(listener: (change: EntityChange) => void): Dispose {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private record(id: string): void {
    if (!this.before.has(id)) this.before.set(id, this.entities.get(id));
  }
  upsert(entity: T, authoritative = false): boolean {
    if (this.disposed) return false;
    this.validate(entity);
    const old = this.entities.get(entity.id);
    if ((!authoritative && !this.accept(entity, old)) || equalData(old, entity))
      return false;
    const next = snapshot(entity);
    this.record(entity.id);
    this.entities.set(entity.id, next);
    this.revisions.set(entity.id, ++this.sequence);
    if (!old) this.idsSnapshot = undefined;
    this.publish();
    return true;
  }
  patch(id: string, changes: Partial<T>): boolean {
    if (changes.id !== undefined && changes.id !== id)
      throw new TradingError(
        "invalid-input",
        "An update cannot change its identity.",
      );
    const old = this.entities.get(id);
    if (!old) return false;
    return this.upsert({ ...old, ...changes, id } as T);
  }
  remove(id: string): boolean {
    if (this.disposed || !this.entities.has(id)) return false;
    this.record(id);
    this.entities.delete(id);
    this.idsSnapshot = undefined;
    this.revisions.delete(id);
    this.sequence++;
    this.publish();
    return true;
  }
  transaction(operation: () => void): void {
    this.depth++;
    try {
      operation();
    } finally {
      this.depth--;
      this.publish();
    }
  }
  /**
   * Replaces the snapshot atomically: one malformed row rejects the whole read. With `quarantine`, invalid rows
   * are set aside instead: valid rows commit, a quarantined ID keeps its previous value, and each failure is
   * returned; a read with rows but none valid still fails as a whole.
   */
  replace(
    entities: readonly T[],
    options: {
      readonly quarantine?: boolean;
      readonly accept?: (entity: T) => boolean;
      /** IDs quarantined by the previous read: quarantined again, they are removed instead of kept. */
      readonly expire?: ReadonlySet<string>;
    } = {},
  ): readonly QuarantinedRow[] {
    if (!Array.isArray(entities))
      throw new TradingError("invalid-input", "The broker returned invalid account information.");
    const incoming = new Map<string, T>();
    const seen = new Set<string>();
    const quarantined: QuarantinedRow[] = [];
    let valid = 0;
    for (const entity of entities) {
      const id = entity && typeof entity === "object" && typeof entity.id === "string" ? entity.id : undefined;
      try {
        this.validate(entity);
        if (seen.has(entity.id))
          throw new TradingError("invalid-input", "The broker returned duplicate identities.");
        seen.add(entity.id);
        if (!options.accept || options.accept(entity)) incoming.set(entity.id, snapshot(entity));
        valid++;
      } catch (cause) {
        if (!options.quarantine) throw cause;
        quarantined.push({ ...(id !== undefined ? { id } : {}), message: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    if (quarantined.length && !valid)
      throw new TradingError("invalid-input", "The broker returned invalid account information.");
    // A quarantined row keeps its previous value for one read; quarantined twice in a row it is removed,
    // so a row the broker keeps sending invalid never shows stale data indefinitely.
    const kept = new Set(
      quarantined.flatMap((row) => (row.id !== undefined && !options.expire?.has(row.id) ? [row.id] : [])),
    );
    this.transaction(() => {
      for (const id of this.entities.keys())
        if (!incoming.has(id) && !kept.has(id)) this.remove(id);
      for (const entity of incoming.values()) this.upsert(entity, true);
    });
    return quarantined;
  }
  private publish(): void {
    if (this.depth || !this.before.size) return;
    const added: string[] = [],
      updated: string[] = [],
      removed: string[] = [];
    for (const [id, old] of this.before) {
      const next = this.entities.get(id);
      if (equalData(old, next)) continue;
      if (!next) removed.push(id);
      else if (!old) added.push(id);
      else updated.push(id);
    }
    this.before.clear();
    if (!added.length && !updated.length && !removed.length) return;
    const change = Object.freeze({
      added: Object.freeze(added),
      updated: Object.freeze(updated),
      removed: Object.freeze(removed),
      revision: this.sequence,
    });
    for (const listener of [...this.listeners]) {
      if (this.disposed) break;
      if (this.listeners.has(listener)) listener(change);
    }
  }
  destroy(): void {
    this.disposed = true;
    this.listeners.clear();
    this.before.clear();
    this.entities.clear();
    this.revisions.clear();
    this.idsSnapshot = Object.freeze([]);
  }
}
