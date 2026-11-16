import { symbolLabel } from '../core/features.js';
import { OrderOrPositionMessageType, OrderStatus, OrderType, Side, StandardFormatterName, StopType } from '../contracts/broker.js';
import type { FieldRef, INumberFormatter } from '../contracts/broker.js';
import { TradingError } from '../core/errors.js';
export interface FormattedCell { readonly text: string; readonly tone?: 'positive' | 'negative' | 'warning'; readonly superscriptLast?: boolean; /** Broker message for the cell, e.g. the Symbol formatter's withMessage dependency. */ readonly message?: string; }
export interface TableFormatContext {
  readonly numeric: INumberFormatter;
  readonly integer: INumberFormatter;
  readonly variable: INumberFormatter;
  readonly quantity: INumberFormatter;
  readonly price: INumberFormatter;
  readonly accountCurrency?: string;
  readonly instrumentType?: string;
  readonly locale: string;
  readonly timezone: string;
  readonly exitLevelLeg?: 'takeProfit' | 'stopLoss';
  /** prefer_symbol_name_over_fullname: show `name` rather than `exchange:name`. */
  readonly preferSymbolName?: boolean;
}
export function fieldValue(row: unknown, reference: FieldRef): unknown {
  const path = Array.isArray(reference) ? reference : [reference];
  let value = row;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function columnValues(row: unknown, fields: readonly FieldRef[]): unknown[] {
  if (!fields.length) return [row];
  return fields.map(field => fieldValue(row, field));
}
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown) => value == null ? '' : String(value);
const tones = (value: number): FormattedCell['tone'] => {
  if (value < 0) return 'negative';
  if (value > 0) return 'positive';
  return undefined;
};
function sideLabel(value: unknown, buy: string, sell: string): string {
  if (value === Side.Buy) return buy;
  if (value === Side.Sell) return sell;
  return '';
}
function messageTone(type: unknown): FormattedCell['tone'] {
  if (type === OrderOrPositionMessageType.Error) return 'negative';
  if (type === OrderOrPositionMessageType.Information) return undefined;
  return 'warning';
}
function percentageTone(value: unknown): FormattedCell['tone'] {
  if (!numeric(value)) return undefined;
  if (value < 0) return 'negative';
  if (value < 5) return 'warning';
  return undefined;
}
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function date(value: unknown, context: TableFormatContext, local: boolean, hasTime: boolean): string {
  if (!numeric(value)) return '';
  const key = `${context.locale}|${local ? context.timezone : 'UTC'}|${hasTime}`;
  let formatter = dateFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(context.locale, { timeZone: local ? context.timezone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', ...(hasTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : {}) });
    if (dateFormats.size >= 64) dateFormats.clear();
    dateFormats.set(key, formatter);
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? '' : formatter.format(timestamp);
}
/** Structured cell output keeps broker text escaped; UI owns colors and superscript markup. */
export function formatStandard(name: StandardFormatterName | undefined, values: readonly unknown[], context: TableFormatContext, showZeroValues = true): FormattedCell {
  const [value, currency] = values;
  if (showZeroValues && value === 0) return { text: '' };
  const number = (formatter = context.numeric) => numeric(value) ? formatter.format(value) : '';
  const withCurrency = (result: string, unit: unknown) => result && unit ? `${result} ${text(unit)}` : result;
  const profit = (amount = value, unit: unknown = context.accountCurrency): FormattedCell => {
    if (!numeric(amount)) return { text: '' };
    const sign = amount > 0 ? '+' : '';
    return { text: withCurrency(sign + context.numeric.format(amount), unit), tone: tones(amount) };
  };
  switch (name) {
    case undefined:
    case StandardFormatterName.Default:
    case StandardFormatterName.Text: return { text: values.map(text).join(' ') };
    case StandardFormatterName.Empty: return { text: '' };
    case StandardFormatterName.Fixed: return { text: number() };
    case StandardFormatterName.VariablePrecision: return { text: number(context.variable) };
    case StandardFormatterName.FixedInCurrency: return { text: withCurrency(number(), currency) };
    case StandardFormatterName.FormatQuantity: return { text: number(context.quantity).replaceAll(',', '\u00a0') };
    case StandardFormatterName.IntegerSeparated: return { text: numeric(value) ? context.integer.format(Math.round(value)).replaceAll(',', '\u00a0') : '' };
    case StandardFormatterName.FormatPrice: return { text: number(context.price) };
    case StandardFormatterName.FormatPriceForexSup: return { text: number(context.price), superscriptLast: context.instrumentType === 'forex' };
    case StandardFormatterName.FormatPriceInCurrency: return { text: withCurrency(number(context.price), currency) };
    case StandardFormatterName.Side: return { text: sideLabel(value, 'Buy', 'Sell') };
    case StandardFormatterName.PositionSide: return { text: sideLabel(value, 'Long', 'Short') };
    case StandardFormatterName.Status: return { text: typeof value === 'number' ? OrderStatus[value] ?? '' : '' };
    case StandardFormatterName.Type: {
      if (values[2] === StopType.TrailingStop) return { text: 'Trailing stop' };
      if (values[2] === StopType.GuaranteedStop) return { text: 'Guaranteed stop' };
      if (value === OrderType.StopLimit) return { text: 'Stop-limit' };
      return { text: typeof value === 'number' ? OrderType[value] ?? '' : '' };
    }
    case StandardFormatterName.Symbol: {
      // Dependencies: [displayName, symbol] or, withMessage, [displayName, symbol, message].
      const symbol = text(value || values[1]);
      // The message is an OrderOrPositionMessage; a plain string is accepted for older brokers.
      const raw = values.length > 2 ? values[2] : undefined;
      const message = raw && typeof raw === 'object' ? text((raw as { text?: unknown }).text) : text(raw);
      const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : OrderOrPositionMessageType.Warning;
      const tone = messageTone(type);
      return {
        text: context.preferSymbolName ? symbolLabel(symbol, { prefer_symbol_name_over_fullname: true }) : symbol,
        ...(message ? { message, ...(tone ? { tone } : {}) } : {}),
      };
    }
    case StandardFormatterName.Pips: return { text: numeric(value) ? `${context.variable.format(value)} pips` : '' };
    case StandardFormatterName.Percentage:
    case StandardFormatterName.ProfitInPercent: return { text: numeric(value) ? `${context.numeric.format(value)}%` : '' };
    case StandardFormatterName.ColoredPercentage: return { text: numeric(value) ? `${context.numeric.format(value)}%` : '', tone: percentageTone(value) };
    case StandardFormatterName.MarginPercent: {
      if (value === undefined) return { text: '' };
      if (typeof value !== 'number') return { text: '' };
      if (!Number.isFinite(value)) return { text: '> 200%' };
      return { text: `${value < 0.01 ? value : context.numeric.format(value)}%` };
    }
    case StandardFormatterName.Profit: return profit();
    case StandardFormatterName.ProfitInInstrumentCurrency: return profit(value, currency);
    case StandardFormatterName.ProfitInInstrumentCurrencyFloored: return profit(numeric(value) ? Math.floor(value * 100) / 100 : undefined, currency);
    case StandardFormatterName.Date:
    case StandardFormatterName.LocalDate: return { text: date(value, context, name === StandardFormatterName.LocalDate, true) };
    case StandardFormatterName.DateOrDateTime:
    case StandardFormatterName.LocalDateOrDateTime: {
      if (!value || typeof value !== 'object') return { text: '' };
      const spec = value as { dateOrDateTime?: unknown; hasTime?: boolean };
      return { text: date(spec.dateOrDateTime, context, name === StandardFormatterName.LocalDateOrDateTime, !!spec.hasTime) };
    }
    case StandardFormatterName.FormatExitLevels: {
      // The legacy price is authoritative for a single level. Multiple-level rendering needs
      // the column's leg key; its caller supplies the selected prices as the second dependency.
      if (numeric(value)) return { text: context.price.format(value) };
      if (!Array.isArray(values[1])) return { text: '' };
      const leg = context.exitLevelLeg;
      const prices = values[1].map(level => {
        if (numeric(level)) return level;
        if (leg && level && typeof level === 'object') return level[leg];
        return undefined;
      }).filter(numeric);
      return { text: prices.map(price => context.price.format(price)).join(', ') };
    }
    default: throw new TradingError('configuration', 'Unknown table formatter.');
  }
}
