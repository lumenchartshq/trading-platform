import { decimalPlaces as places } from "../core/number-precision.js";
import type {
  FormatterParseOptions,
  NumberFormatterFormatOptions,
  INumberFormatter,
  IPriceFormatter,
  PriceFormatterFormatOptions,
} from "../contracts/broker.js";
import type {
  TradingFormatterPort,
  TradingSymbolContext,
} from "../contracts/ports.js";
import { TradingError } from "../core/errors.js";
import { effectiveTick, snapToStep } from "../core/trading-rules.js";
function precision(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 20)
    throw new TradingError("invalid-input", "Invalid number precision.");
  return value;
}
function parser(locale: string) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find((part) => part.type === "group")?.value,
    decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  return (text: string, options?: FormatterParseOptions) => {
    let normalized = text
      .trim()
      .replace(/[\u200e\u200f\u2066-\u2069]/g, "")
      .replace("−", "-");
    if (!options?.ignoreLocaleNumberFormat) {
      if (group) normalized = normalized.split(group).join("");
      normalized = normalized.replace(decimal, ".");
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized))
      return { res: false as const, error: "Enter a number." };
    const value = Number(normalized);
    return Number.isFinite(value)
      ? { res: true as const, value }
      : { res: false as const, error: "Enter a finite number." };
  };
}
export function createNumericFormatter(
  locale: string,
  decimalPlaces = 2,
  trim = false,
): INumberFormatter {
  precision(decimalPlaces);
  const localeFormat = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumFractionDigits: trim ? 0 : decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  });
  const plainFormat = new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumFractionDigits: trim ? 0 : decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  });
  const format: INumberFormatter["format"] = (value, options) => {
    if (value === undefined) return "";
    if (!Number.isFinite(value)) return String(value);
    const normalized = Object.is(value, -0) ? 0 : value;
    return (
      options?.ignoreLocaleNumberFormat ? plainFormat : localeFormat
    ).format(normalized);
  };
  const parse = parser(locale);
  return Object.freeze({
    format,
    // A successful parse suggests the canonical display text for the value.
    parse: (text: string, options?: FormatterParseOptions) => {
      const result = parse(text, options);
      return result.res ? { ...result, suggest: format(result.value, options) } : result;
    },
    formatChange: (
      current: number,
      previous: number,
      options?: NumberFormatterFormatOptions,
    ) => format(current - previous, options),
  });
}
export function createPriceFormatter(
  locale: string,
  priceScale = 100,
  minMove = 1,
  fractional = false,
  minMove2 = 0,
  variableMinTick?: string,
  align = true,
): IPriceFormatter {
  if (
    !Number.isFinite(priceScale) ||
    priceScale <= 0 ||
    !Number.isFinite(minMove) ||
    minMove <= 0 ||
    ![0, 2, 4, 8].includes(minMove2)
  )
    throw new TradingError("invalid-input", "Invalid price precision.");
  if (
    fractional &&
    (variableMinTick ||
      !Number.isInteger(priceScale) ||
      (minMove2 > 0 && priceScale % minMove2 !== 0))
  )
    throw new TradingError(
      "invalid-input",
      "Invalid fractional price precision.",
    );
  const minimumTick = minMove / priceScale,
    parseNumber = parser(locale);
  if (variableMinTick)
    effectiveTick(0, { minTick: minimumTick, variableMinTick });
  const numericCache = new Map<string, INumberFormatter>();
  const format = (
    value: number,
    options: PriceFormatterFormatOptions = {},
  ): string => {
    if (!Number.isFinite(value)) return String(value);
    const tick = effectiveTick(value, {
      minTick: minimumTick,
      variableMinTick,
    });
    const rounded =
      align && !options.cutFractionalByPrecision
        ? snapToStep(value, tick)
        : value;
    const negative = rounded < 0 || options.signNegative,
      sign = negative ? "-" : options.signPositive && rounded > 0 ? "+" : "";
    let body: string;
    if (fractional) {
      const units = Math.round(Math.abs(rounded) * priceScale),
        whole = Math.floor(units / priceScale),
        remainder = units % priceScale;
      const divisor = minMove2 || 1,
        scale = priceScale / divisor;
      const fraction = Math.floor(remainder / divisor)
        .toString()
        .padStart(String(scale - 1).length, "0");
      body = `${whole}'${fraction}`;
      if (minMove2)
        body += `'${Math.floor(((remainder % divisor) * 10) / divisor)}`;
    } else {
      const decimals = variableMinTick ? places(tick) : places(1 / priceScale);
      const digits = precision(decimals + (options.tailSize ?? 0));
      const magnitude = Math.abs(rounded),
        factor = 10 ** digits;
      const number = options.cutFractionalByPrecision
        ? Math.trunc(magnitude * factor) / factor
        : magnitude;
      const cacheKey = `${digits}:${!!options.removeAllEndingZeros}`;
      let formatter = numericCache.get(cacheKey);
      if (!formatter) {
        formatter = createNumericFormatter(
          locale,
          digits,
          !!options.removeAllEndingZeros,
        );
        numericCache.set(cacheKey, formatter);
      }
      body = formatter.format(number, options);
    }
    const text = sign + body;
    return options.useRtlFormat ? `\u2067${text}\u2069` : text;
  };
  return Object.freeze({
    format,
    formatChange: (
      current: number,
      previous: number,
      options?: PriceFormatterFormatOptions,
    ) => format(current - previous, { signPositive: true, ...options }),
    parse(text: string, options?: FormatterParseOptions) {
      if (!fractional) return parseNumber(text, options);
      const match = /^([+-]?)(\d+)'(\d+)(?:'(\d))?$/.exec(text.trim());
      if (!match)
        return { res: false as const, error: "Enter a fractional price." };
      const scale = priceScale / (minMove2 || 1),
        whole = Number(match[2]),
        fraction = Number(match[3]);
      if (fraction >= scale || !!match[4] !== !!minMove2)
        return { res: false as const, error: "Check the fractional price." };
      let sub = 0;
      if (minMove2) {
        const digit = Number(match[4]);
        const candidate = Array.from(
          { length: minMove2 },
          (_, index) => index,
        ).find((index) => Math.floor((index * 10) / minMove2) === digit);
        if (candidate === undefined)
          return { res: false as const, error: "Check the fractional price." };
        sub = candidate / priceScale;
      }
      const value =
        (whole + fraction / scale + sub) * (match[1] === "-" ? -1 : 1);
      return { res: true as const, value };
    },
  });
}
/** Standalone fallback; provider/broker custom formatters retain precedence in the session. */
export function createDefaultTradingFormatters(
  locale: string,
  symbolContext: (symbol: string) => Promise<TradingSymbolContext>,
): TradingFormatterPort {
  return Object.freeze({
    defaultPrice: async (symbol: string, align: boolean) => {
      const context = await symbolContext(symbol);
      if (!context.resolved)
        throw new TradingError(
          "broker-unavailable",
          "Symbol price precision is unavailable.",
        );
      return createPriceFormatter(
        locale,
        context.priceScale,
        context.minMove,
        context.fractional,
        context.minMove2,
        context.variableMinTick,
        align,
      );
    },
    numeric: async (digits: number) => createNumericFormatter(locale, digits),
    quantity: async (digits?: number) =>
      createNumericFormatter(locale, digits ?? 8, digits === undefined),
    createPriceFormatter: (
      priceScale?: number,
      minMove?: number,
      fractional?: boolean,
      minMove2?: number,
      variableMinTick?: string,
    ) =>
      createPriceFormatter(
        locale,
        priceScale,
        minMove,
        fractional,
        minMove2,
        variableMinTick,
      ),
  });
}
