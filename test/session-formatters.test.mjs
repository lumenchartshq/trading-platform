import { mapSettings } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./load-module.mjs";
import { deferred, flush } from "./manual-clock.mjs";
const { createTradingSession } = await loadModule("src/core/session.ts");
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
async function fixture(
  configure = () => {},
  numeric = async () => ({ format: String }),
) {
  const simulation = createDeterministicBroker(),
    settings = new Map();
  let prices = 0,
    quantities = 0;
  const session = createTradingSession({
    ...simulation,
    brokerFactory: (host) => {
      const broker = simulation.brokerFactory(host);
      broker.formatter = async () => {
        prices++;
        return { format: String };
      };
      broker.quantityFormatter = async () => {
        quantities++;
        return { format: String };
      };
      configure(broker);
      return broker;
    },
    settings: mapSettings(settings),
    formatters: {
      defaultPrice: async () => ({ format: String }),
      quantity: async () => ({ format: String }),
      numeric,
      createPriceFormatter: () => ({ format: String }),
    },
  });
  await session.ready;
  return { session, simulation, counts: () => ({ prices, quantities }) };
}
test("U06/U08: concurrent cells share one formatter bundle per symbol and account generation", async () => {
  let numerics = 0;
  const f = await fixture(undefined, async () => {
    numerics++;
    return { format: String };
  });
  try {
    const values = await Promise.all(
      Array.from({ length: 60 }, () => f.session.formatters("SIM:X")),
    );
    assert(values.every((value) => value === values[0]));
    assert.deepEqual(f.counts(), { prices: 1, quantities: 1 });
    assert.equal(numerics, 3);
    assert.equal(await f.session.formatters("SIM:X"), values[0]);
    await f.session.commands.selectAccount("simulation-B");
    assert.notEqual(await f.session.formatters("SIM:X"), values[0]);
    assert.deepEqual(f.counts(), { prices: 2, quantities: 2 });
  } finally {
    f.session.destroy();
  }
});
test("A03/U08: formatter results from an old account cannot settle as current", async () => {
  const pending = deferred();
  let reads = 0;
  const f = await fixture((broker) => {
    broker.formatter = async () => {
      reads++;
      if (reads === 1) return pending.promise;
      return { format: (value) => `fresh ${value}` };
    };
  });
  try {
    const old = assert.rejects(
      f.session.formatters("SIM:X"),
      (error) => error.code === "stale-context",
    );
    await flush();
    await f.session.commands.selectAccount("simulation-B");
    const fresh = await f.session.formatters("SIM:X");
    pending.resolve({ format: (value) => `old ${value}` });
    await old;
    assert.equal(await f.session.formatters("SIM:X"), fresh);
    assert.equal(fresh.price.format(1), "fresh 1");
    assert.equal(reads, 2);
  } finally {
    f.session.destroy();
  }
});
test("A02/U08: failed or timed-out formatter providers permit explicit retry and are disposed with their session", async () => {
  let block = true;
  const f = await fixture(undefined, async (places) =>
    places === 8 && block ? new Promise(() => {}) : { format: String },
  );
  try {
    const failed = assert.rejects(
      f.session.formatters("SIM:X"),
      /took too long/,
    );
    await flush();
    f.simulation.clock.advance(15000);
    await failed;
    block = false;
    const result = await f.session.formatters("SIM:X");
    assert.equal(result.numeric.format(1), "1");
    assert.equal(f.counts().prices, 2);
    f.session.destroy();
    await assert.rejects(
      f.session.formatters("SIM:X"),
      (error) => error.code === "disposed",
    );
  } finally {
    f.session.destroy();
  }
});

test("U06/U08: symbol-less custom table rows use generic formatter ports instead of an invented broker symbol", async () => {
  const f = await fixture();
  try {
    const value = await f.session.formatters("");
    assert.equal(value.quantity.format(2), "2");
    assert.deepEqual(f.counts(), { prices: 0, quantities: 0 });
  } finally {
    f.session.destroy();
  }
});

test("U08: malformed formatter results reject at the boundary and do not poison a later retry", async () => {
  let reads = 0;
  const f = await fixture((broker) => {
    broker.formatter = async () =>
      ++reads === 1 ? undefined : { format: String };
  });
  try {
    await assert.rejects(
      f.session.formatters("SIM:X"),
      (error) => error.code === "configuration",
    );
    assert.equal((await f.session.formatters("SIM:X")).price.format(1), "1");
    assert.equal(reads, 2);
  } finally {
    f.session.destroy();
  }
});
