import { OrderType } from "../contracts/broker.js";
import type {
  InstrumentInfo,
  OrderDuration,
  PreOrder,
} from "../contracts/broker.js";
import { durationsForType } from "./capabilities.js";
import type { CapabilityPolicy } from "./capabilities.js";
export function durationOptions(
  policy: CapabilityPolicy,
  type: OrderType,
  instrument?: InstrumentInfo,
) {
  return durationsForType(policy, type).filter(
    (option) =>
      !instrument?.allowedDurations ||
      instrument.allowedDurations.includes(option.value),
  );
}
export function defaultDuration(
  policy: CapabilityPolicy,
  type: OrderType,
  instrument?: InstrumentInfo,
): OrderDuration | undefined {
  const option = durationOptions(policy, type, instrument).find(
    (option) => option.default,
  );
  return option ? { type: option.value } : undefined;
}
/** Broker defaults apply to new orders, including silent placement; existing orders retain their explicit fields. */
export function withDefaultDuration<T extends PreOrder>(
  order: T,
  policy: CapabilityPolicy,
  instrument?: InstrumentInfo,
): T {
  if (order.duration || "id" in order) return order;
  const duration = defaultDuration(
    policy,
    order.type ?? OrderType.Market,
    instrument,
  );
  return duration ? { ...order, duration } : order;
}
export interface DisplayDateTime {
  readonly date: string;
  readonly time: string;
}
function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function parts(format: Intl.DateTimeFormat, milliseconds: number) {
  const values = Object.fromEntries(
    format.formatToParts(milliseconds).map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}
export function displayDateTime(
  seconds: number,
  timezone: string,
): DisplayDateTime | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  try {
    return parts(formatter(timezone), seconds * 1000);
  } catch {
    return undefined;
  }
}
/** Reject DST gaps and repeated local times rather than silently choosing a different instant. */
export function expirationSeconds(
  input: DisplayDateTime,
  timezone: string,
): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    `${input.date}T${input.time}`,
  );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((value) => Number(value ?? 0));
  if (year < 1970 || year > 9999 || hour > 23 || minute > 59 || second > 59)
    return undefined;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(naive);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  try {
    const format = formatter(timezone),
      offsets = new Set<number>(),
      matches = new Set<number>();
    // Nearby offsets cover both sides of a timezone transition without a locale-dependent parser.
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = naive + hours * 3600000,
        display = parts(format, sample);
      offsets.add(Date.parse(`${display.date}T${display.time}Z`) - sample);
    }
    const expectedTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    for (const offset of offsets) {
      const candidate = naive - offset,
        display = parts(format, candidate);
      if (display.date === input.date && display.time === expectedTime)
        matches.add(candidate / 1000);
    }
    return matches.size === 1 ? [...matches][0] : undefined;
  } catch {
    return undefined;
  }
}
