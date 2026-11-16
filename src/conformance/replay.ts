import type { IBrokerConnectionAdapterHost, IBrokerTerminal } from "../contracts/broker.js";

/** One host push or broker call, in the order it happened. Values are JSON data. */
export type TranscriptEvent =
  | { readonly kind: "push"; readonly method: string; readonly args: readonly unknown[] }
  | {
      readonly kind: "call";
      readonly method: string;
      readonly args: readonly unknown[];
      /** The method returned a promise. */
      readonly async: boolean;
      readonly result?: unknown;
      readonly error?: string;
    };
export interface BrokerTranscript {
  readonly version: 1;
  /** Broker methods that existed, so capability checks see the same adapter. */
  readonly methods: readonly string[];
  readonly events: readonly TranscriptEvent[];
}
const pushMethods: ReadonlySet<string> = new Set([
  "orderUpdate",
  "orderPartialUpdate",
  "ordersFullUpdate",
  "positionUpdate",
  "positionPartialUpdate",
  "positionsFullUpdate",
  "individualPositionUpdate",
  "individualPositionPartialUpdate",
  "individualPositionsFullUpdate",
  "executionUpdate",
  "realtimeUpdate",
  "plUpdate",
  "individualPositionPLUpdate",
  "equityUpdate",
  "marginAvailableUpdate",
  "cryptoBalanceUpdate",
  "pipValueUpdate",
  "domUpdate",
  "connectionStatusUpdate",
  "currentAccountUpdate",
  "patchConfig",
  "setDurations",
  "showNotification",
]);
/** JSON data only: functions, watched values' methods and class behaviour are dropped. */
function data(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as { then?: unknown }).then === "function";

/**
 * Wraps a broker factory and records every host push and broker call with its result, so the session's
 * conversation with a real adapter can be replayed offline by `createReplayBroker`.
 */
export function recordBroker(factory: (host: IBrokerConnectionAdapterHost) => IBrokerTerminal) {
  const events: TranscriptEvent[] = [];
  let methods: string[] = [];
  const recordingFactory = (host: IBrokerConnectionAdapterHost): IBrokerTerminal => {
    const recordingHost = new Proxy(host, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function" || !pushMethods.has(property)) return value;
        return (...args: unknown[]) => {
          events.push({ kind: "push", method: property, args: args.map(data) });
          return value.apply(target, args);
        };
      },
    });
    const broker = factory(recordingHost);
    methods = [];
    for (let source: object | null = broker; source && source !== Object.prototype; source = Object.getPrototypeOf(source))
      for (const name of Object.getOwnPropertyNames(source))
        if (name !== "constructor" && typeof (broker as unknown as Record<string, unknown>)[name] === "function" && !methods.includes(name))
          methods.push(name);
    return new Proxy(broker, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const index = events.length;
          events.push({ kind: "call", method: property, args: args.map(data), async: false });
          const record = (patch: Partial<Extract<TranscriptEvent, { kind: "call" }>>) => {
            events[index] = { ...(events[index] as Extract<TranscriptEvent, { kind: "call" }>), ...patch };
          };
          try {
            const result = value.apply(target, args);
            if (!isThenable(result)) {
              record({ result: data(result) });
              return result;
            }
            record({ async: true });
            return Promise.resolve(result).then(
              (resolved) => {
                record({ result: data(resolved) });
                return resolved;
              },
              (error: unknown) => {
                record({ error: error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error) });
                throw error;
              },
            );
          } catch (error) {
            record({ error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        };
      },
    });
  };
  return {
    brokerFactory: recordingFactory,
    transcript: (): BrokerTranscript => ({ version: 1, methods: [...methods], events: data(events) as TranscriptEvent[] }),
  };
}

/**
 * A broker that answers each method from a transcript, in order, and delivers the host pushes recorded after
 * each call. Pushes recorded before the first call are delivered during construction. A call the transcript
 * does not have rejects (or returns undefined for synchronous methods).
 */
export function createReplayBroker(
  transcript: BrokerTranscript,
  overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {},
) {
  if (transcript.version !== 1) throw new Error("Unsupported transcript version.");
  return (host: IBrokerConnectionAdapterHost): IBrokerTerminal => {
    let cursor = 0;
    const deliver = () => {
      while (cursor < transcript.events.length && transcript.events[cursor]!.kind === "push") {
        const event = transcript.events[cursor++]!;
        const method = (host as unknown as Record<string, (...args: unknown[]) => unknown>)[event.method];
        method?.apply(host, structuredClone(event.args) as unknown[]);
      }
    };
    const answer = (method: string, args: unknown[]): unknown => {
      const override = overrides[method];
      if (override) return override(...args);
      let index = cursor;
      while (index < transcript.events.length) {
        const event = transcript.events[index]!;
        if (event.kind === "call" && event.method === method) break;
        index++;
      }
      const event = transcript.events[index];
      if (!event || event.kind !== "call") return Promise.reject(new Error(`No recorded ${method} call.`));
      // Pushes that followed earlier calls are delivered before this call is answered; unmatched calls are skipped.
      for (; cursor < index; cursor++) {
        const pending = transcript.events[cursor]!;
        if (pending.kind !== "push") continue;
        const push = (host as unknown as Record<string, (...values: unknown[]) => unknown>)[pending.method];
        push?.apply(host, structuredClone(pending.args) as unknown[]);
      }
      cursor = index + 1;
      const result = structuredClone(event.result);
      queueMicrotask(deliver);
      if (event.async) return event.error ? Promise.reject(new Error(event.error)) : Promise.resolve(result);
      if (event.error) throw new Error(event.error);
      return result;
    };
    const broker: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of new Set([...transcript.methods, ...Object.keys(overrides)]))
      broker[method] = (...args: unknown[]) => answer(method, args);
    deliver();
    return broker as unknown as IBrokerTerminal;
  };
}
