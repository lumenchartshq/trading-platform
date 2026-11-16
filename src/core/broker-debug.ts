/** Pinned `debug_broker` modes: `normal` omits high-frequency host pushes, `all` logs everything. */
export type BrokerDebugMode = "all" | "normal" | "host-only" | "broker-only";
export type BrokerDebugLogger = (message: string, ...details: unknown[]) => void;

const frequentHostMethods = new Set([
  "realtimeUpdate",
  "plUpdate",
  "individualPositionPLUpdate",
  "pipValueUpdate",
  "equityUpdate",
  "marginAvailableUpdate",
  "cryptoBalanceUpdate",
  "domUpdate",
]);

/**
 * Log calls and results on one side of the Broker API. Each call gets an ID so asynchronous results can be matched.
 * Only own function properties are wrapped; values, `this` and thrown errors pass through unchanged.
 */
export function debugBrokerSide<T extends object>(
  target: T,
  side: "host" | "broker",
  mode: BrokerDebugMode | undefined,
  log: BrokerDebugLogger,
  sequence: { next: number },
): T {
  if (!mode) return target;
  if (side === "host" && mode === "broker-only") return target;
  if (side === "broker" && mode === "host-only") return target;
  const quiet = (name: string) =>
    mode === "normal" && side === "host" && frequentHostMethods.has(name);
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function" || typeof property !== "string" || quiet(property))
        return value;
      if (wrapped.has(property)) return wrapped.get(property);
      const call = function (this: unknown, ...args: unknown[]) {
        const id = ++sequence.next;
        log(`[${side} #${id}] ${property}`, ...args);
        try {
          const result = (value as (...values: unknown[]) => unknown).apply(
            this === receiver ? object : this,
            args,
          );
          if (result && typeof (result as Promise<unknown>).then === "function")
            (result as Promise<unknown>).then(
              (resolved) => log(`[${side} #${id}] ${property} resolved`, resolved),
              (cause) => log(`[${side} #${id}] ${property} rejected`, cause),
            );
          else log(`[${side} #${id}] ${property} returned`, result);
          return result;
        } catch (cause) {
          log(`[${side} #${id}] ${property} threw`, cause);
          throw cause;
        }
      };
      wrapped.set(property, call);
      return call;
    },
  });
}
