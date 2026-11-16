import { userMessage } from "./core/errors.js";
import type {
  NativeTradingOptions,
  TradingModule,
  TradingRuntime,
} from "./contracts/ports.js";
import { createTradingSession } from "./core/session.js";
import { DisposalScope } from "./core/disposal.js";
import { createDefaultTradingFormatters } from "./compat/default-formatters.js";
import { createTradingMarketData } from "./market-data/subscriptions.js";
import { mountTradingPlatform } from "./ui/mount.js";

/** The optional asset owns the session; direct UI consumers may supply their own. */
export function createTradingModule(buildId: string): TradingModule {
  if (!buildId.trim()) throw new Error("A trading build identity is required.");
  return Object.freeze({
    abi: 1 as const,
    buildId,
    mount(options: NativeTradingOptions): TradingRuntime {
      if (options.abi !== 1 || options.buildId !== buildId) {
        throw new Error("The chart and trading assets do not match.");
      }
      const scope = new DisposalScope();
      try {
        const ticks = new Map<string, number>();
        const adapter = options.session.marketData
          ? undefined
          : createTradingMarketData(options.datafeed ?? {}, (symbol) => {
              const tick = ticks.get(symbol);
              if (tick === undefined)
                throw new Error("Symbol price precision is unavailable.");
              return tick;
            });
        if (adapter) scope.own(() => adapter.destroy());
        let active = true;
        scope.own(() => {
          active = false;
        });
        const session = createTradingSession({
          ...options.session,
          displaySettings: {
            ...options.session.displaySettings,
            ...options.displayOverrides?.get(),
          },
          formatters:
            options.session.formatters ??
            createDefaultTradingFormatters(
              options.presentation.environment.get().locale,
              async (symbol) => {
                const chart = options.collection
                  .charts()
                  .find((chart) => chart.binding.get().symbol === symbol);
                if (!chart)
                  throw new Error("Symbol price precision is unavailable.");
                return chart.symbolContext();
              },
            ),
          marketDataCapabilities:
            options.session.marketDataCapabilities ??
            (options.session.marketData
              ? undefined
              : {
                  quotes: !!(
                    options.datafeed?.getQuotes &&
                    options.datafeed.subscribeQuotes &&
                    options.datafeed.unsubscribeQuotes
                  ),
                  depth: !!(
                    options.datafeed?.subscribeDepth &&
                    options.datafeed.unsubscribeDepth
                  ),
                }),
          marketData: options.session.marketData ?? {
            acquireQuotes: (symbol, speed, listener) =>
              adapter!.acquireQuotes(symbol, speed, listener),
            acquireDepth(symbol, listener) {
              let owned = true,
                release: (() => void) | undefined;
              void session
                .symbolInfo(symbol)
                .then((instrument) => {
                  if (!active || !owned) return;
                  ticks.set(symbol, instrument.minTick);
                  release = adapter!.acquireDepth(symbol, listener);
                })
                .catch((cause) => {
                  if (active && owned)
                    session.host.showNotification(
                      "Market depth unavailable",
                      userMessage(cause, "Try again."),
                    );
                });
              return () => {
                owned = false;
                release?.();
              };
            },
          },
        });
        scope.own(() => session.destroy());
        if (options.displayOverrides) {
          scope.own(
            options.displayOverrides.subscribe((value) =>
              session.updateDisplaySettings(value),
            ),
          );
          // Broker construction can reenter the host before the subscription exists.
          session.updateDisplaySettings(options.displayOverrides.get());
        }
        const ui = mountTradingPlatform({
          session,
          collection: options.collection,
          presentation: options.presentation,
        });
        scope.own(() => ui.destroy());
        const ready = session.ready.catch((cause: unknown) => {
          try {
            scope.destroy();
          } catch {
            /* Preserve the initialization failure. */
          }
          throw cause;
        });
        // Installation does not wait for broker hydration; callers may observe ready.
        void ready.catch(() => {});
        return Object.freeze({ ready, destroy: () => scope.destroy() });
      } catch (cause) {
        try {
          scope.destroy();
        } catch {
          /* Preserve the mounting failure. */
        }
        throw cause;
      }
    },
  });
}
