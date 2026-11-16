import type { IBrokerConnectionAdapterFactory } from '../contracts/broker.js';
import type { TradingFormatterPort } from '../contracts/ports.js';
import { DisposalScope } from '../core/disposal.js';
import { TradingError } from '../core/errors.js';
import { Delegate } from './delegate.js';
import { WatchedValue } from './watched-value.js';
/** Every utility created for the broker belongs to this session's lifetime. */
export function createHostFactory(formatters: TradingFormatterPort, scope: DisposalScope): IBrokerConnectionAdapterFactory {
  let disposed = false;
  scope.own(() => { disposed = true; });
  const assertAlive = () => { if (disposed) throw TradingError.disposed(); };
  return {
    createDelegate<T extends Function>() {
      assertAlive();
      const delegate = new Delegate<T>();
      scope.own(() => delegate.destroy());
      return delegate;
    },
    createWatchedValue<T>(value?: T) {
      assertAlive();
      const watched = new WatchedValue<T>(value);
      scope.own(() => watched.destroy());
      return watched;
    },
    createPriceFormatter(...args) { assertAlive(); return formatters.createPriceFormatter(...args); },
  };
}
