import { snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";

/** A broker's suggested way to make a symbol tradable. */
export type TradabilitySolution =
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "symbol"; readonly symbol: string }
  | { readonly kind: "url"; readonly url: string; readonly text: string };
/** Normalized `isTradable` result: broker text is bounded plain text, URLs are http(s) only. */
export interface Tradability {
  readonly tradable: boolean;
  readonly reason?: string;
  readonly heading?: string;
  readonly shortReason?: string;
  /** Main action text when no solution is offered. */
  readonly buttonText?: string;
  readonly solution?: TradabilitySolution;
}

const text = (value: unknown, limit = 300) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;
function solution(value: unknown): TradabilitySolution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const account = text(entry.changeAccount, 200);
  if (account) return { kind: "account", accountId: account };
  const symbol = text(entry.changeSymbol, 200);
  if (symbol) return { kind: "symbol", symbol };
  const link = entry.openUrl as Record<string, unknown> | undefined;
  const url = text(link?.url, 2000);
  if (url && /^https?:\/\//i.test(url))
    return { kind: "url", url, text: text(link?.text, 80) ?? "Open link" };
  return undefined;
}

/** Validate provider data without invoking accessor properties; boolean and object forms are both accepted. */
export function normalizeTradability(value: unknown): Tradability {
  const result = snapshot(value);
  if (typeof result === "boolean") return Object.freeze({ tradable: result });
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { tradable?: unknown }).tradable !== "boolean"
  )
    throw new TradingError(
      "configuration",
      "The broker returned an invalid trading status.",
    );
  const entry = result as Record<string, unknown>;
  const normalized: Tradability = {
    tradable: entry.tradable as boolean,
    reason: text(entry.reason),
    heading: text(entry.reasonHeading, 120),
    shortReason: text(entry.shortReason, 80),
    buttonText: text(entry.confirmButtonText, 80),
    solution: solution(entry.solutions),
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(normalized).filter(([, item]) => item !== undefined),
    ) as unknown as Tradability,
  );
}

/** Commands refuse a non-tradable symbol with the broker's reason when one is given. */
export function assertTradable(value: unknown): void {
  const tradability = normalizeTradability(value);
  if (!tradability.tradable)
    throw new TradingError(
      "unsupported",
      tradability.reason ?? "This symbol is unavailable for trading.",
    );
}
