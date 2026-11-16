import { KeyedRefCount, releaseAll } from "./keyed-ref-count.js";
import type { Execution } from "../contracts/broker.js";
import type {
  TradingClock,
  Dispose,
} from "../contracts/ports.js";
import { EntityStore } from "./entity-store.js";
import { validateExecution } from "./entity-validation.js";
import { SnapshotDataset } from "./snapshot-dataset.js";
import { TradingError } from "./errors.js";

interface Demand {
  dataset: SnapshotDataset<Execution>;
  releaseProjection: Dispose;
}
/** Execution snapshots are symbol-scoped; refreshing one symbol never replaces another. */
export function createExecutionDemand(
  target: EntityStore<Execution>,
  load: (symbol: string) => Promise<Execution[]>,
  clock: TradingClock,
  report: (cause: unknown) => void,
  deadline = 15000,
) {
  const demands = new KeyedRefCount<string, Demand>(demand => releaseAll([
    demand.releaseProjection,
    () => demand.dataset.destroy(),
    () => demand.dataset.store.destroy(),
  ]));
  let active = false,
    disposed = false;
  const refresh = (demand: Demand) => {
    void demand.dataset.refresh().catch((cause) => {
      if (
        cause instanceof TradingError &&
        (cause.code === "disposed" || cause.code === "stale-context")
      )
        return;
      report(cause);
    });
  };
  return {
    acquire(symbol: string): Dispose {
      if (disposed)
        throw TradingError.disposed();
      if (!symbol)
        throw new TradingError("invalid-input", "A symbol is required.");
      const lease = demands.acquire(symbol, () => {
        const store = new EntityStore<Execution>((execution) => {
          validateExecution(execution);
          if (execution.symbol !== symbol)
            throw new TradingError(
              "invalid-input",
              "An execution belongs to another symbol.",
            );
        });
        for (const id of target.ids()) {
          const execution = target.get(id)!;
          if (execution.symbol === symbol) store.upsert(execution);
        }
        const releaseProjection = store.subscribeChanges((change) =>
          target.transaction(() => {
            for (const id of change.removed)
              if (target.get(id)?.symbol === symbol) target.remove(id);
            for (const id of [...change.added, ...change.updated])
              target.upsert(store.get(id)!);
          }),
        );
        const dataset = new SnapshotDataset(store, () => load(symbol), clock, undefined, undefined, undefined, false, deadline);
        return { dataset, releaseProjection };
      });
      if (lease.first && active) refresh(lease.value);
      return lease.release;
    },
    push(execution: Execution): void {
      const demand = demands.get(execution.symbol);
      if (demand) demand.dataset.push(execution);
      else target.upsert(execution);
    },
    suspend(clear = false): void {
      active = false;
      for (const demand of demands.values()) demand.dataset.invalidate(clear);
    },
    resume(): void {
      if (disposed || active) return;
      active = true;
      for (const demand of demands.values()) refresh(demand);
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      demands.releaseAll();
    },
  };
}
