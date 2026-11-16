import { preferencesKey } from "./preferences-key.js";
import type {
  TradingDisplaySettings,
  TradingLineAlignment,
  TradingProfitDisplayMode,
  TradingSettingsPort,
} from "../contracts/ports.js";
import { ValueStore } from "./value-store.js";
import { valueReader } from "./readers.js";
import { snapshot, equalData } from "./immutable.js";
import { TradingError } from "./errors.js";
export function isProfitDisplayMode(
  value: unknown,
): value is TradingProfitDisplayMode {
  return value === "money" || value === "ticks" || value === "percentage";
}
export function isLineAlignment(value: unknown): value is TradingLineAlignment {
  return value === "left" || value === "center" || value === "right";
}
type DisplayKey = keyof TradingDisplaySettings;
/** Every display setting with its validity rule and the message for an invalid value. */
const displayFields: { readonly [Key in DisplayKey]-?: readonly [(value: unknown) => boolean, string] } = {
  positionProfitDisplay: [isProfitDisplayMode, "Choose a valid profit display."],
  showPositionProfit: [isBoolean, "Choose whether position profit is visible."],
  multipleExitLevels: [isBoolean, "Choose whether to add multiple exit levels."],
  showBuySellButtons: [isBoolean, "Choose whether buy and sell buttons are visible."],
  showProfit: [isBoolean, "Choose whether profit and loss is visible."],
  showBracketProfit: [isBoolean, "Choose whether bracket profit is visible."],
  bracketProfitDisplay: [isProfitDisplayMode, "Choose a valid bracket profit display."],
  showPositions: [isBoolean, "Choose whether positions are visible."],
  showOrders: [isBoolean, "Choose whether orders are visible."],
  showReverse: [isBoolean, "Choose whether the reverse button is visible."],
  showExecutions: [isBoolean, "Choose whether execution marks are visible."],
  showExecutionLabels: [isBoolean, "Choose whether execution labels are visible."],
  extendLines: [isBoolean, "Choose whether price lines are extended."],
  lineAlignment: [isLineAlignment, "Choose a valid line alignment."],
  executionSound: [isBoolean, "Choose whether executions play a sound."],
  rejectionNotificationsOnly: [isBoolean, "Choose which notifications are shown."],
};
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function normalizedPatch(
  input: Partial<TradingDisplaySettings>,
): Partial<TradingDisplaySettings> {
  const patch = snapshot(input);
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new TradingError(
      "invalid-input",
      "Trading display settings must be an object.",
    );
  if (Object.keys(patch).some((key) => !Object.hasOwn(displayFields, key)))
    throw new TradingError("invalid-input", "Unknown trading display setting.");
  const result: Record<string, unknown> = {};
  for (const [key, [valid, message]] of Object.entries(displayFields)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!valid(value)) throw new TradingError("invalid-input", message);
    result[key] = value;
  }
  return result as Partial<TradingDisplaySettings>;
}
/** Saved fields only; unknown or invalid saved values are dropped one by one. */
function savedPatch(data: Record<string, unknown>): Partial<TradingDisplaySettings> {
  const result: Record<string, unknown> = {};
  for (const [key, [valid]] of Object.entries(displayFields))
    if (data[key] !== undefined && valid(data[key])) result[key] = data[key];
  return result as Partial<TradingDisplaySettings>;
}
/** Scoped user choices; storage failures never turn a valid UI choice into a trading failure. */
export function createDisplayPreferences(
  storage: TradingSettingsPort,
  namespace: string,
  initial: Partial<TradingDisplaySettings> = {},
) {
  const key = preferencesKey(namespace, "position-display");
  let saved: Partial<TradingDisplaySettings> = {};
  try {
    const raw = storage.get(key);
    if (raw && raw.length <= 2048) {
      const data = JSON.parse(raw);
      if (data?.schemaVersion === 1 && typeof data === "object") saved = savedPatch(data);
    }
  } catch {
    /* Invalid/unavailable saved choices use the default display. */
  }
  const state = new ValueStore<TradingDisplaySettings>(
    Object.freeze({
      positionProfitDisplay: "money",
      showPositionProfit: true,
      ...saved,
      ...normalizedPatch(initial),
    }),
  );
  const error = new ValueStore<string | undefined>(undefined);
  let alive = true;
  return {
    state: valueReader(state),
    error: valueReader(error),
    update(input: Partial<TradingDisplaySettings>): void {
      if (!alive)
        throw TradingError.disposed();
      const next = Object.freeze({ ...state.get(), ...normalizedPatch(input) });
      const changed = !equalData(state.get(), next);
      if (!changed && !error.get()) return;
      if (changed) state.set(next);
      try {
        storage.set(key, JSON.stringify({ schemaVersion: 1, ...next }));
        error.set(undefined);
      } catch {
        error.set("Your display choice could not be saved.");
      }
    },
    destroy(): void {
      if (!alive) return;
      alive = false;
      state.destroy();
      error.destroy();
    },
  };
}
