import type { IBrokerTerminal, InstrumentInfo, SymbolSpecificTradingOptions } from "../contracts/broker.js";
import type { TradingFormatterPort } from "../contracts/ports.js";
import type { TableFormatContext } from "../compat/formatters.js";
import { BoundedMap } from "./bounded-map.js";
import { ValueStore } from "./value-store.js";
import { valueReader } from "./readers.js";
import { snapshot } from "./immutable.js";
import { TradingError } from "./errors.js";
export type TradingFormatters = Readonly<
    Pick<
      TableFormatContext,
      "price" | "quantity" | "numeric" | "integer" | "variable"
    > & {
      /** Broker spreadFormatter when provided; otherwise spreads use the price formatter. */
      spread?: TableFormatContext["numeric"];
    }
  >;

interface Services {
  readonly ready: Promise<IBrokerTerminal>;
  readonly fallbackFormatters: TradingFormatterPort;
  alive(): boolean;
  generation(): number;
  broker(): IBrokerTerminal;
  read<T>(load: () => T | Promise<T>, epoch?: number): Promise<T>;
  /** Observes each instrument the broker returns; it cannot affect the lookup. */
  loaded?(symbol: string, instrument: InstrumentInfo): void;
}
/** Symbol metadata/options and formatter caches share the session's generation fence. */
export class SymbolCatalog {
  // Bounded like the formatter cache: long sessions across many symbols keep the most recently used entries.
  private readonly symbolRequests = new BoundedMap<string, Promise<InstrumentInfo>>();
  /** Lookups still running are keyed apart from the bounded cache, so eviction can never fail a caller. */
  private readonly inflight = new Map<string, Promise<InstrumentInfo>>();
  private readonly symbolOptions = new BoundedMap<string, SymbolSpecificTradingOptions>();
  private readonly formatterRequests = new BoundedMap<string, Promise<TradingFormatters>>();
  private readonly revisionState = new ValueStore(0);
  readonly revision = valueReader(this.revisionState);
  constructor(private readonly services: Services) {}
  private symbolOptionsChanged(): void { this.revisionState.set(this.revisionState.get() + 1); }
  options(symbol: string): SymbolSpecificTradingOptions | undefined { return this.symbolOptions.get(symbol); }
  invalidate(): void {
    this.inflight.clear();
    this.symbolRequests.clear();
    if (this.symbolOptions.size) { this.symbolOptions.clear(); this.symbolOptionsChanged(); }
    this.formatterRequests.clear();
  }
  async refresh(symbol: string): Promise<InstrumentInfo> {
    this.inflight.delete(symbol);
    this.symbolRequests.delete(symbol);
    this.symbolOptions.delete(symbol);
    return this.info(symbol);
  }
  destroy(): void {
    this.inflight.clear(); this.symbolRequests.clear(); this.symbolOptions.clear(); this.formatterRequests.clear();
    this.revisionState.destroy();
  }
  readonly info = async (symbol: string): Promise<InstrumentInfo> => {
    await this.services.ready;
    if (!this.services.alive())
      throw TradingError.disposed();
    let request = this.symbolRequests.get(symbol) ?? this.inflight.get(symbol);
    if (!request) {
      request = this.services.read(async () => {
        const current = this.services.broker();
        const [instrument, specific] = await Promise.all([
          current.symbolInfo(symbol),
          current.getSymbolSpecificTradingOptions?.(symbol),
        ]);
        return { instrument, specific };
      }).then(({ instrument, specific }) => {
        // A refresh or invalidation replaced this lookup; its answer belongs to an earlier context.
        if (this.inflight.get(symbol) !== request)
          throw new TradingError(
            "stale-context",
            "Symbol information changed while loading.",
          );
        this.inflight.delete(symbol);
        this.symbolRequests.set(symbol, request!);
        if (specific) {
          this.symbolOptions.set(
            symbol,
            snapshot(specific),
          );
          this.symbolOptionsChanged();
        }
        const value = snapshot(instrument);
        try {
          this.services.loaded?.(symbol, value);
        } catch {
          /* An observer cannot fail a symbol lookup. */
        }
        return value;
      });
      this.inflight.set(symbol, request);
      void request.catch(() => {
        if (this.inflight.get(symbol) === request) this.inflight.delete(symbol);
      });
    }
    return request;
    };
  readonly formatters = (symbol: string): Promise<TradingFormatters> => {
    if (!this.services.alive())
      return Promise.reject(
        TradingError.disposed(),
      );
    const cached = this.formatterRequests.get(symbol);
    if (cached) {
      this.formatterRequests.delete(symbol);
      this.formatterRequests.set(symbol, cached);
      return cached;
    }
    const current = this.services.broker(),
      epoch = this.services.generation();
    const request = Promise.all([
      this.services.read(
        () =>
          current.formatter && symbol
            ? current.formatter(symbol, true)
            : this.services.fallbackFormatters.defaultPrice(symbol, true),
        epoch,
      ),
      this.services.read(
        () =>
          current.quantityFormatter && symbol
            ? current.quantityFormatter(symbol)
            : this.services.fallbackFormatters.quantity(),
        epoch,
      ),
      this.services.read(() => this.services.fallbackFormatters.numeric(2), epoch),
      this.services.read(() => this.services.fallbackFormatters.numeric(0), epoch),
      this.services.read(() => this.services.fallbackFormatters.numeric(8), epoch),
      current.spreadFormatter && symbol
        ? this.services.read(() => current.spreadFormatter!(symbol), epoch).catch(
            () => undefined,
          )
        : undefined,
    ]).then(([price, quantity, numeric, integer, variable, spread]) => {
      if (!this.services.alive() || epoch !== this.services.generation())
        throw TradingError.accountChanged();
      if (
        [price, quantity, numeric, integer, variable].some(
          (formatter) => typeof formatter?.format !== "function",
        )
      )
        throw new TradingError(
          "configuration",
          "A price or number formatter is unavailable.",
        );
      return Object.freeze({
        price,
        quantity,
        numeric,
        integer,
        variable,
        ...(typeof spread?.format === "function" ? { spread } : {}),
      });
    });
    // Bound visited-symbol retention; evicted promises still settle for their original caller.
    this.formatterRequests.set(symbol, request);
    void request.catch(() => {
      if (this.formatterRequests.get(symbol) === request)
        this.formatterRequests.delete(symbol);
    });
    return request;
    };
}
