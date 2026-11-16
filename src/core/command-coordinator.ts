import type { TradingClock } from "../contracts/ports.js";
import { EntityStore } from "./entity-store.js";
import { deferred } from "./deferred.js";
import { TradingError, brokerRejectionError } from "./errors.js";
export type CommandOutcome = "confirmed" | "changed" | "unconfirmed";
export interface TradingCommandResult {
  readonly commandId: string;
  readonly outcome: CommandOutcome;
  readonly entityIds: readonly string[];
}
export interface PendingOperation {
  readonly id: string;
  readonly keys: readonly string[];
  readonly stage:
    | "dispatched"
    | "awaitingUpdate"
    | "confirmed"
    | "changed"
    | "rejected"
    | "unconfirmed";
  readonly dispatchedAt: number;
  readonly entityIds: readonly string[];
  readonly error?: string;
  /**
   * True while an unconfirmed operation is still being reconciled after its deadline. An `unconfirmed` record whose
   * reconciliation has ended is unresolved: only the user can decide what happened.
   */
  readonly reconciling?: boolean;
}
export interface CommandMatch {
  readonly outcome: "confirmed" | "changed";
  readonly entityIds: readonly string[];
}
export interface CommandSpec<T> {
  readonly keys: readonly string[];
  readonly dispatch: () => Promise<T>;
  readonly match: (
    result: T | undefined,
    accepted: boolean,
  ) => CommandMatch | undefined;
  readonly refresh: () => void;
  readonly dispose?: () => void;
}
interface Operation<T = unknown> {
  readonly id: string;
  readonly spec: CommandSpec<T>;
  readonly completion: ReturnType<typeof deferred<TradingCommandResult>>;
  readonly timer: unknown;
  /** The next follow-up reconciliation after the deadline. */
  followUp?: unknown;
  accepted: boolean;
  response?: T;
  settled: boolean;
  disposed: boolean;
}
function rejectionError(cause: unknown): TradingError {
  return brokerRejectionError(cause, "The broker could not complete the operation.");
}
/** Follow-up reconciliation delays after the deadline; the last one repeats until the window ends. */
const followUpDelays = [2000, 4000, 8000, 16000, 30000];
/**
 * Transport acceptance and a matching authoritative update are separate conditions. The deadline only changes what
 * callers are told: an unconfirmed operation keeps its keys and keeps asking the broker to reconcile for a bounded
 * window, so a late match or rejection still settles its record and a repeat action cannot race it.
 */
export class CommandCoordinator {
  readonly pending = new EntityStore<PendingOperation>(() => {});
  private readonly operations = new Map<string, Operation>();
  private readonly locks = new Map<string, string>();
  private sequence = 0;
  private disposed = false;
  constructor(
    private readonly clock: TradingClock,
    /** Milliseconds from dispatch until an operation without a matching update is unconfirmed. */
    private readonly deadline = 10000,
    /** Milliseconds after the deadline that an unconfirmed operation keeps reconciling and holds its keys; 0 ends it at the deadline. */
    private readonly reconcileWindow = 60000,
  ) {}
  execute<T>(spec: CommandSpec<T>): Promise<TradingCommandResult> {
    if (this.disposed) {
      spec.dispose?.();
      return Promise.reject(
        TradingError.disposed(),
      );
    }
    if (spec.keys.some((key) => this.locks.has(key))) {
      spec.dispose?.();
      return Promise.reject(
        new TradingError(
          "operation-pending",
          "Wait for the pending operation.",
        ),
      );
    }
    this.evict();
    if (this.operations.size >= 200) {
      spec.dispose?.();
      return Promise.reject(
        new TradingError(
          "operation-pending",
          "Too many operations are pending.",
        ),
      );
    }
    const id = `command-${++this.sequence}`;
    const completion = deferred<TradingCommandResult>();
    const timer = this.clock.setTimeout(() => {
      this.settle(id, "unconfirmed");
      spec.refresh();
    }, this.deadline);
    const operation: Operation<T> = {
      id,
      spec,
      completion,
      timer,
      accepted: false,
      settled: false,
      disposed: false,
    };
    this.operations.set(id, operation as Operation);
    for (const key of spec.keys) this.locks.set(key, id);
    this.pending.upsert({
      id,
      keys: [...spec.keys],
      stage: "dispatched",
      dispatchedAt: this.clock.now(),
      entityIds: [],
    });
    try {
      Promise.resolve(spec.dispatch()).then(
        (response) => {
          if (
            this.disposed ||
            operation.disposed ||
            (operation.settled && this.pending.get(id)?.stage !== "unconfirmed")
          )
            return;
          operation.response = response;
          operation.accepted = true;
          if (!operation.settled)
            this.pending.patch(id, { stage: "awaitingUpdate" });
          this.evaluate(operation as Operation);
        },
        (error) => {
          if (operation.settled) this.rejectLate(operation as Operation, error);
          else this.reject(id, error);
        },
      );
    } catch (error) {
      this.reject(id, error);
    }
    return completion.promise;
  }
  executeBatch(
    specs: readonly Omit<CommandSpec<void>, "dispatch">[],
    dispatch: () => Promise<void>,
  ): Promise<PromiseSettledResult<TradingCommandResult>[]> {
    if (this.disposed)
      return Promise.reject(
        TradingError.disposed(),
      );
    const keys = specs.flatMap((spec) => spec.keys);
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => this.locks.has(key))
    )
      return Promise.reject(
        new TradingError(
          "operation-pending",
          "Wait for the pending operations.",
        ),
      );
    this.evict(200 - specs.length);
    if (this.operations.size + specs.length > 200)
      return Promise.reject(
        new TradingError(
          "operation-pending",
          "Too many operations are pending.",
        ),
      );
    const transport = deferred<void>();
    const operations: Promise<TradingCommandResult>[] = [];
    this.pending.transaction(() => {
      for (const spec of specs)
        operations.push(
          this.execute({ ...spec, dispatch: () => transport.promise }),
        );
    });
    try {
      Promise.resolve(dispatch()).then(
        () => transport.resolve(),
        (cause) => transport.reject(cause),
      );
    } catch (cause) {
      transport.reject(cause);
    }
    return Promise.allSettled(operations);
  }
  changed(): void {
    for (const operation of this.operations.values()) {
      if (operation.disposed) continue;
      if (
        operation.settled &&
        this.pending.get(operation.id)?.stage !== "unconfirmed"
      )
        continue;
      this.evaluate(operation);
    }
  }
  private evaluate(operation: Operation): void {
    try {
      const match = operation.spec.match(
        operation.response,
        operation.accepted,
      );
      if (!match || !operation.accepted) return;
      if (operation.settled) {
        this.pending.patch(operation.id, {
          stage: match.outcome,
          entityIds: [...match.entityIds],
          reconciling: false,
        });
        this.finishReconciling(operation);
        return;
      }
      this.settle(operation.id, match.outcome, match.entityIds);
    } catch (cause) {
      if (operation.settled) this.rejectLate(operation, cause);
      else this.reject(operation.id, cause);
    }
  }
  private settle(
    id: string,
    outcome: CommandOutcome,
    entityIds: readonly string[] = [],
  ): void {
    const operation = this.operations.get(id);
    if (!operation || operation.settled) return;
    operation.settled = true;
    this.clock.clearTimeout(operation.timer);
    const reconciling = outcome === "unconfirmed" && this.reconcileWindow > 0;
    if (!reconciling) this.unlock(operation);
    this.pending.patch(id, { stage: outcome, entityIds: [...entityIds], ...(reconciling && { reconciling }) });
    if (reconciling) this.followUp(operation, 0, this.clock.now() + this.reconcileWindow);
    else this.dispose(operation);
    operation.completion.resolve(
      Object.freeze({
        commandId: id,
        outcome,
        entityIds: Object.freeze([...entityIds]),
      }),
    );
  }
  private reject(id: string, cause: unknown): void {
    const operation = this.operations.get(id);
    if (!operation || operation.settled) return;
    operation.settled = true;
    this.clock.clearTimeout(operation.timer);
    this.unlock(operation);
    const error = rejectionError(cause);
    this.pending.patch(id, { stage: "rejected", error: error.message });
    this.dispose(operation);
    operation.completion.reject(error);
  }
  /** A transport rejection after the deadline corrects the unconfirmed record; the completion keeps its outcome. */
  private rejectLate(operation: Operation, cause: unknown): void {
    if (this.disposed || operation.disposed || this.pending.get(operation.id)?.stage !== "unconfirmed") return;
    this.pending.patch(operation.id, { stage: "rejected", error: rejectionError(cause).message, reconciling: false });
    this.finishReconciling(operation);
  }
  /** Asks the broker to reconcile again with backoff until a match, a rejection or the end of the reconcile period. */
  private followUp(operation: Operation, attempt: number, endsAt: number): void {
    if (this.disposed || operation.disposed) return;
    const delay = Math.min(followUpDelays[Math.min(attempt, followUpDelays.length - 1)], endsAt - this.clock.now());
    operation.followUp = this.clock.setTimeout(() => {
      operation.followUp = undefined;
      if (this.disposed || operation.disposed) return;
      if (this.clock.now() >= endsAt) {
        // Unresolved: keys are released so the user can act deliberately on what they now see.
        this.pending.patch(operation.id, { reconciling: false });
        this.finishReconciling(operation);
        return;
      }
      operation.spec.refresh();
      this.followUp(operation, attempt + 1, endsAt);
    }, Math.max(0, delay));
  }
  private finishReconciling(operation: Operation): void {
    if (operation.followUp !== undefined) this.clock.clearTimeout(operation.followUp);
    operation.followUp = undefined;
    this.unlock(operation);
    this.dispose(operation);
  }
  private unlock(operation: Operation): void {
    for (const key of operation.spec.keys)
      if (this.locks.get(key) === operation.id) this.locks.delete(key);
  }
  private dispose(operation: Operation): void {
    if (operation.disposed) return;
    operation.disposed = true;
    operation.spec.dispose?.();
  }
  private evict(target = 199): void {
    // Keep the most recent 200 records; never evict an active operation.
    if (this.operations.size <= target) return;
    for (const [id, operation] of this.operations) {
      if (!operation.settled || operation.followUp !== undefined) continue;
      this.dispose(operation);
      this.operations.delete(id);
      this.pending.remove(id);
      if (this.operations.size <= target) return;
    }
  }
  /** Old-generation operations can never match, so their listeners are released at once. */
  suspend(): void {
    for (const operation of this.operations.values()) {
      this.settle(operation.id, "unconfirmed");
      if (operation.followUp !== undefined) this.pending.patch(operation.id, { reconciling: false });
      this.finishReconciling(operation);
    }
  }
  destroy(): void {
    if (this.disposed) return;
    for (const operation of this.operations.values())
      this.reject(
        operation.id,
        TradingError.disposed(),
      );
    for (const operation of this.operations.values()) this.finishReconciling(operation);
    this.disposed = true;
    this.operations.clear();
    this.locks.clear();
    this.pending.destroy();
  }
}
