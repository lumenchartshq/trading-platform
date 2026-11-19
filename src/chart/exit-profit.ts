import { bracketProfitMode, bracketProfitVisible } from "../core/trading-settings.js";
import type { InstrumentInfo, PipValues } from "../contracts/broker.js";
import type { TradingDisplaySettings } from "../contracts/ports.js";
import { positionProfit } from "../core/financial-rules.js";
import { decimalPlaces } from "../core/number-precision.js";
import type { ProtectionField } from "../core/protection-legs.js";
import type { PositionProfitCurrency } from "../core/position-profit-currency.js";

/** Instruments whose pip differs from the minimum tick count in pips; everything else counts ticks. */
export function profitTickUnit(instrument: Pick<InstrumentInfo, "pipSize" | "minTick">): "pips" | "ticks" {
  return instrument.pipSize && instrument.pipSize !== instrument.minTick ? "pips" : "ticks";
}

export interface ExitProfitInput {
  readonly instrument: InstrumentInfo | undefined;
  /** Side of the exposure the exit closes, not the side of the exit order. */
  readonly side: number;
  readonly qty: number;
  readonly entry: number | undefined;
  readonly exit: number;
  readonly display: TradingDisplaySettings;
  readonly pipValues?: PipValues;
  /** From `positionProfitCurrency`; instrument-currency money also skips the pip-value conversion. */
  readonly currency: PositionProfitCurrency;
}

/** Estimated result of closing at an exit price, as chart pill text; undefined when it cannot be shown. */
/** What chart money shows while the host's privacy mode is on. */
export const MASKED_MONEY = "***";

export function exitProfitText(input: ExitProfitInput): string | undefined {
  const { instrument, display } = input;
  if (!instrument || input.entry === undefined || !bracketProfitVisible(display)) return undefined;
  const mode = bracketProfitMode(display);
  const amount = positionProfit({
    position: { side: input.side, qty: input.qty, avgPrice: input.entry },
    instrument,
    quotes: { bid: input.exit, ask: input.exit },
    mode,
    supportPLUpdate: false,
    source: "chart",
    pipValues: input.pipValues,
    inInstrumentCurrency: input.currency.source === "instrument",
  });
  if (amount === undefined) return undefined;
  const value = `${amount > 0 ? "+" : ""}${amount.toFixed(2)}`;
  if (mode === "percentage") return `${value}%`;
  if (mode === "ticks") return `${value} ${profitTickUnit(instrument)}`;
  const unit = input.currency.currency;
  return unit ? `${value} ${unit}` : undefined;
}

const exitNames: Record<ProtectionField, string> = {
  takeProfit: "Take Profit",
  stopLoss: "Stop Loss",
  guaranteedStop: "Guaranteed Stop",
  trailingStopPips: "Trailing Stop",
};

function signed(value: number, digits: number): string {
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (Number(text.replace(/,/g, "")) === 0) return text;
  return `${value > 0 ? "+" : "-"}${text}`;
}

/**
 * Hover text for a confirmed exit line, as in the reference terminal: its distance from entry in profit terms
 * (percent, then ticks or pips) and its price. Undefined without an entry or a valid tick.
 */
export function exitTooltip(input: {
  readonly field: ProtectionField;
  /** Side of the exposure the exit closes. */
  readonly side: number;
  readonly entry: number | undefined;
  readonly exit: number;
  readonly instrument: Pick<InstrumentInfo, "pipSize" | "minTick"> | undefined;
}): string | undefined {
  const { instrument, entry, exit } = input;
  if (!instrument || entry === undefined || !Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit) || !(instrument.minTick > 0))
    return undefined;
  const move = (exit - entry) * Math.sign(input.side);
  const unit = profitTickUnit(instrument);
  const step = unit === "pips" ? instrument.pipSize! : instrument.minTick;
  const distance = Number((move / step).toPrecision(12));
  const price = exit.toLocaleString("en-US", {
    minimumFractionDigits: decimalPlaces(instrument.minTick),
    maximumFractionDigits: decimalPlaces(instrument.minTick),
  });
  return `${exitNames[input.field]} ${signed((move / Math.abs(entry)) * 100, 2)}% ${signed(distance, unit === "pips" ? 1 : 0)} ${unit}\nPrice ${price}`;
}
