import { TradingError } from "./errors.js";
/** Parent-frame DTOs have a different Object.prototype; inspect without invoking it. */
function ordinaryRecordPrototype(prototype: object | null): boolean {
  if (prototype === null || prototype === Object.prototype) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  return (
    !!constructor &&
    "value" in constructor &&
    typeof constructor.value === "function" &&
    Function.prototype.toString.call(constructor.value) ===
      Function.prototype.toString.call(Object)
  );
}
/** Tests a DTO record without enumerating unrelated provider fields. */
export function isOrdinaryDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ordinaryRecordPrototype(Object.getPrototypeOf(value))
  );
}
/** Values `snapshot()` produced: already deep-frozen plain records, so later passes return them unchanged. */
const produced = new WeakSet<object>();
function copyData(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    value === undefined ||
    ["string", "number", "boolean", "bigint"].includes(typeof value)
  )
    return value;
  if (typeof value === "object" && produced.has(value)) return value;
  if (typeof value !== "object")
    throw new TradingError(
      "invalid-input",
      "Broker data cannot contain executable values.",
    );
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && !ordinaryRecordPrototype(prototype))
    throw new TradingError(
      "invalid-input",
      "Broker data must contain ordinary records.",
    );
  if (ancestors.has(value))
    throw new TradingError(
      "invalid-input",
      "Broker data cannot contain circular records.",
    );
  ancestors.add(value);
  const result: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor))
      throw new TradingError(
        "invalid-input",
        "Broker data cannot contain accessors.",
      );
    Object.defineProperty(result, key, {
      value: copyData(descriptor.value, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  Object.freeze(result);
  produced.add(result);
  return result;
}
/**
 * Deep-frozen clone that never executes broker getters. A value this function already produced is returned as
 * is, so the host boundary's copy is the one defensive pass for each push.
 * Typed as T so callers keep their own readonly annotations. Callback-bearing configuration has its own path. */
export function snapshot<T>(value: T): T {
  return copyData(value, new Set()) as T;
}
export function equalData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = Object.getOwnPropertyDescriptor(a, key);
    const right = Object.getOwnPropertyDescriptor(b, key);
    return (
      !!left &&
      !!right &&
      "value" in left &&
      "value" in right &&
      equalData(left.value, right.value)
    );
  });
}
