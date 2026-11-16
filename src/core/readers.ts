import type {
  Dispose,
  ReadonlyValue,
} from "../contracts/ports.js";
import type {
  EntityChange,
  EntityReader,
  EntityStore,
} from "./entity-store.js";

/** Consumer callbacks cannot interrupt authoritative state commits or other consumers. */
function subscribeConsumer<T>(
  subscribe: (listener: (value: T) => void) => Dispose,
  listener: (value: T) => void,
): Dispose {
  let active = true;
  const release = subscribe((value) => {
    if (!active) return;
    try {
      listener(value);
    } catch {
      // Presentation/integration callbacks do not own the producer's update lifecycle.
    }
  });
  return () => {
    if (!active) return;
    active = false;
    release();
  };
}
export function entityReader<T extends { id: string }>(
  store: EntityStore<T>,
): EntityReader<T> {
  return Object.freeze({
    ids: () => store.ids(),
    get: (id: string) => store.get(id),
    revision: (id: string) => store.revision(id),
    subscribeChanges: (listener: (change: EntityChange) => void) =>
      subscribeConsumer(store.subscribeChanges.bind(store), listener),
  });
}
export function valueReader<T>(store: ReadonlyValue<T>): ReadonlyValue<T> {
  return Object.freeze({
    get: () => store.get(),
    subscribe: (listener: (value: T) => void) =>
      subscribeConsumer(store.subscribe.bind(store), listener),
  });
}
