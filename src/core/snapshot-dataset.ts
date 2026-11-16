import { userMessage } from './errors.js';
import type { TradingClock } from '../contracts/ports.js';
import { EntityStore } from './entity-store.js';
import { TradingError } from './errors.js';
import { snapshot } from './immutable.js';
import { ValueStore } from './value-store.js';
import { deferred } from './deferred.js';
export type ReadStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
/** `warnings` counts snapshot rows quarantined by the last successful read (see `EntityStore.replace`). */
export interface DatasetStatus { readonly status: ReadStatus; readonly error?: string; readonly warnings?: number; }
type Update<T> = { kind: 'full'; entity: T } | { kind: 'partial'; id: string; patch: Partial<T> } | { kind: 'after'; id: string; apply: () => void };
/** One read per account scope, at most one trailing resync, and ordered push replay. */
export class SnapshotDataset<T extends { id: string }> {
  readonly status = new ValueStore<DatasetStatus>({ status: 'idle' });
  private epoch = 0;
  private active: ReturnType<typeof deferred<void>> | undefined;
  private timer: unknown;
  private buffered: Update<T>[] = [];
  /** IDs the last successful read quarantined. */
  private quarantinedLast: ReadonlySet<string> = new Set();
  private queued = false;
  private disposed = false;
  constructor(
    readonly store: EntityStore<T>,
    private readonly load: () => Promise<T[]>,
    private readonly clock: TradingClock,
    private readonly apply: (entity: T) => void = entity => { store.upsert(entity); },
    private readonly diagnostic: (message: string, entityId?: string) => void = () => {},
    /** Rows a snapshot read keeps; pushes use `apply` instead (for example, quantity-zero positions). */
    private readonly accept?: (entity: T) => boolean,
    /** Account datasets set aside invalid rows (`warnings`); others reject the whole read. */
    private readonly quarantine = false,
    private readonly deadline = 15000,
  ) {}
  push(entity: T): void { this.update({ kind: 'full', entity: snapshot(entity) }); }
  partial(id: string, patch: Partial<T>): void { this.update({ kind: 'partial', id, patch: snapshot(patch) }); }
  /** Apply dependent updates in arrival order after an in-flight snapshot and its buffered pushes. */
  afterUpdates(id: string, apply: () => void): void {
    if (this.disposed) return;
    if (this.active) { this.buffered.push({ kind: 'after', id, apply }); return; }
    apply();
  }
  private update(update: Update<T>): void {
    if (this.disposed) return;
    if (this.active) { this.buffered.push(update); return; }
    if (update.kind === 'after') { update.apply(); return; }
    if (update.kind === 'full') { this.apply(update.entity); return; }
    if (this.store.get(update.id)) { this.store.patch(update.id, update.patch); return; }
    // Start the read before returning to the adapter, so subsequent unknown patches coalesce.
    this.buffered.push(update);
    void this.refresh().catch(() => {});
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.reject(TradingError.disposed());
    if (this.active) { this.queued = true; return this.active.promise; }
    const operation = deferred<void>();
    this.active = operation;
    const epoch = this.epoch;
    this.status.set({ status: 'loading' });
    const timer = this.clock.setTimeout(() => finish(new TradingError('broker-unavailable', 'Account information took too long to load.')), this.deadline);
    this.timer = timer;
    const finish = (error?: unknown, entities?: T[]) => {
      if (this.disposed || epoch !== this.epoch || this.active !== operation) return;
      this.clock.clearTimeout(timer);
      this.timer = undefined;
      const updates = this.buffered;
      this.buffered = [];
      this.active = undefined;
      let warnings = 0;
      try {
        this.store.transaction(() => {
          if (entities) {
            const quarantined = this.store.replace(
              entities,
              { quarantine: this.quarantine, accept: this.accept, expire: this.quarantinedLast },
            );
            warnings = quarantined.length;
            this.quarantinedLast = new Set(quarantined.flatMap((row) => (row.id !== undefined ? [row.id] : [])));
            for (const row of quarantined) this.diagnostic(row.message, row.id);
          }
          // Each buffered push stands alone: one invalid push cannot fail the snapshot it follows.
          for (const update of updates) {
            const id = update.kind === 'full' ? update.entity?.id : update.id;
            try {
              if (update.kind === 'full') this.apply(update.entity);
              else if (update.kind === 'after') update.apply();
              else if (this.store.get(update.id)) this.store.patch(update.id, update.patch);
              else this.diagnostic(`Dropped partial update for unknown ID ${update.id}.`, update.id);
            } catch (cause) {
              this.diagnostic(cause instanceof Error ? cause.message : String(cause), id);
            }
          }
        });
        if (error) {
          this.status.set({ status: this.store.ids().length ? 'stale' : 'error', error: userMessage(error, 'Account information is unavailable.') });
          operation.reject(error);
        } else { this.status.set(warnings ? { status: 'ready', warnings } : { status: 'ready' }); operation.resolve(); }
      } catch (cause) { this.status.set({ status: 'error', error: 'The broker returned invalid account information.' }); operation.reject(cause); }
      if (this.queued) { this.queued = false; void this.refresh().catch(() => {}); }
    };
    // Invoke now, not in a later microtask: constructor/synchronous pushes must enter this buffer.
    try { Promise.resolve(this.load()).then(entities => finish(undefined, entities), error => finish(error)); }
    catch (error) { finish(error); }
    return operation.promise;
  }
  invalidate(clear = false): void {
    this.quarantinedLast = new Set();
    this.epoch++;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.reject(new TradingError('stale-context', 'The account changed while loading.'));
    this.active = undefined;
    this.queued = false;
    this.buffered = [];
    if (clear) this.store.replace([]);
    this.status.set({ status: 'stale' });
  }
  destroy(): void {
    if (this.disposed) return;
    this.invalidate(); this.disposed = true; this.status.destroy();
  }
}
