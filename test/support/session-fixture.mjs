import { loadModule } from '../load-module.mjs';
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');

export const stringFormatters = {
  defaultPrice: async () => ({ format: String }),
  numeric: async () => ({ format: String }),
  quantity: async () => ({ format: String }),
  createPriceFormatter: () => ({ format: String }),
};

export function mapSettings(values = new Map()) {
  return {
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
    remove: key => values.delete(key),
  };
}

/** Seed a real session; keep scenario-specific broker behavior at the call site. */
export async function simulatedSession({
  simulation = createDeterministicBroker(),
  flags = {},
  configureBroker,
  options = {},
} = {}) {
  Object.assign(simulation.brokerConfig.configFlags, flags);
  let broker, host;
  const session = createTradingSession({
    ...simulation,
    settings: mapSettings(),
    formatters: stringFormatters,
    ...options,
    brokerFactory: value => {
      host = value;
      broker = (options.brokerFactory ?? simulation.brokerFactory)(host);
      configureBroker?.(broker, host, simulation);
      return broker;
    },
  });
  await session.ready;
  return { simulation, session, broker, host };
}
