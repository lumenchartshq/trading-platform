import { stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { OrderType, Side } = await loadModule('src/contracts/broker.ts');
async function fixture(debugBroker) {
  const simulation = createDeterministicBroker(), logs = [];
  let host;
  const session = createTradingSession({
    ...simulation, debugBroker, debugLogger: (message, ...details) => logs.push([message, details]),
    brokerFactory: (value) => { host = value; return simulation.brokerFactory(value); },
    settings: { get: () => undefined, set() {}, remove() {} },
    formatters: stringFormatters,
  });
  await session.ready;
  return { simulation, session, logs, host: () => host };
}
test('X08/U08: debug_broker logs broker calls and matching asynchronous results by ID', async () => {
  const f = await fixture('broker-only');
  try {
    await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: 'SIM:X', type: OrderType.Limit, side: Side.Buy, qty: 1, limitPrice: 99 } });
    await flush();
    const call = f.logs.find(([message]) => /^\[broker #\d+\] placeOrder$/.test(message));
    assert(call, 'the call is logged with its arguments');
    assert.equal(call[1][0].limitPrice, 99);
    const id = call[0].match(/#(\d+)/)[1];
    assert(f.logs.some(([message]) => message === `[broker #${id}] placeOrder resolved`), 'the result reuses the call ID');
    assert.equal(f.logs.some(([message]) => message.startsWith('[host')), false, 'broker-only never logs host calls');
  } finally { f.session.destroy(); }
});
test('X08/U08: normal mode logs host calls but omits high-frequency pushes; all mode includes them; no mode logs nothing', async () => {
  const normal = await fixture('normal');
  try {
    normal.simulation.controls.quote('SIM:X', 101);
    normal.host().orderUpdate({ id: 'debug-order', symbol: 'SIM:X', side: Side.Buy, type: OrderType.Limit, qty: 1, limitPrice: 99, status: 6 });
    assert(normal.logs.some(([message]) => /^\[host #\d+\] orderUpdate$/.test(message)));
    assert.equal(normal.logs.some(([message]) => message.includes('realtimeUpdate')), false);
  } finally { normal.session.destroy(); }
  const all = await fixture('all');
  try {
    all.host().realtimeUpdate('SIM:X', { bid: 1, ask: 2 });
    assert(all.logs.some(([message]) => message.includes('realtimeUpdate')));
  } finally { all.session.destroy(); }
  const off = await fixture(undefined);
  try { assert.deepEqual(off.logs, []); } finally { off.session.destroy(); }
});
