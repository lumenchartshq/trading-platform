import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { runConformance, conformanceScenarios, recordBroker, createReplayBroker } = await loadModule('src/conformance/index.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { createTradingSession } = await loadModule('src/core/session.ts');
const { stringFormatters, mapSettings } = await import('./support/session-fixture.mjs');

/** Scenarios the deterministic mock cannot exercise, with the reason. Everything else must pass. */
const mockSkips = new Map([
  ['P02', "positionPLInInstrumentCurrency is off; money P&L uses account-currency pip values"],
  ['R01', 'no holdNextWrite control'],
  ['R02', 'no loseNextReply control'],
]);

function mockSetup(profile = 'equity-net') {
  return () => {
    const simulation = createDeterministicBroker({ profile });
    return {
      brokerFactory: simulation.brokerFactory,
      brokerConfig: simulation.brokerConfig,
      extensions: simulation.extensions,
      marketData: simulation.marketData,
      clock: simulation.clock,
      symbol: 'SIM:X',
      price: 100,
      qty: 1,
      controls: {
        quote: (symbol, price) => simulation.controls.quote(symbol, price),
        fill: id => simulation.controls.fill(id),
        disconnect: () => simulation.controls.disconnect(),
        reconnect: () => simulation.controls.reconnect(),
        rejectNext: message => simulation.controls.rejectNextOperation(message, { brokerRejection: true }),
      },
      rejectsWithBrokerRejection: true,
    };
  };
}

test('X08/A01–C01: the deterministic broker passes the conformance kit with an explicit skip list', async () => {
  const report = await runConformance({ name: 'deterministic mock', setup: mockSetup() });
  const failures = report.results.filter(result => result.status === 'fail');
  assert.deepEqual(failures.map(result => `${result.id}: ${result.reason}`), []);
  for (const result of report.results.filter(result => result.status === 'skip'))
    assert.equal(mockSkips.get(result.id), result.reason, `unexpected skip ${result.id}: ${result.reason}`);
  assert.deepEqual(report.results.map(result => result.id), conformanceScenarios);
  assert.equal(report.passed + report.skipped, conformanceScenarios.length);
});
test('X08: a scenario whose control is missing is skipped, not passed', async () => {
  const setup = mockSetup();
  const report = await runConformance({ name: 'no controls', scenarios: ['A02', 'O02'], setup: () => ({ ...setup(), controls: undefined }) });
  assert.deepEqual(report.results.map(result => [result.id, result.status]), [['A02', 'skip'], ['O02', 'skip']]);
});
test('X08: a declared profile makes its scenarios required, so missing controls fail instead of skipping', async () => {
  const setup = mockSetup();
  const report = await runConformance({
    name: 'declares eventual confirmation', scenarios: ['R01', 'R02'],
    setup: () => ({ ...setup(), profile: { confirmation: 'eventual', clientOrderIds: true } }),
  });
  assert.deepEqual(report.results.map(result => [result.id, result.status, result.reason]), [
    ['R01', 'fail', 'the profile declares eventual confirmation, so it must provide holdNextWrite'],
    ['R02', 'fail', 'the profile declares client order IDs, so it must provide loseNextReply'],
  ]);
  const immediate = await runConformance({
    name: 'declares immediate confirmation', scenarios: ['R01', 'R02'],
    setup: () => ({ ...setup(), profile: { confirmation: 'immediate', clientOrderIds: false } }),
  });
  assert.deepEqual(immediate.results.map(result => result.status), ['skip', 'skip']);
});
test('X08: a broker that breaks a rule fails its scenario with evidence', async () => {
  const setup = mockSetup();
  const report = await runConformance({
    name: 'never confirms', scenarios: ['O01'], timeout: 200,
    setup: () => {
      const value = setup();
      return { ...value, brokerFactory: host => { const broker = value.brokerFactory(host); broker.placeOrder = async () => ({}); return broker; } };
    },
  });
  assert.equal(report.results[0].status, 'fail');
  assert(report.results[0].evidence.some(line => line.startsWith('placeOrder')));
});
test('X08/A01: a recorded session replays offline into the same account state', async () => {
  const simulation = createDeterministicBroker();
  const recorder = recordBroker(simulation.brokerFactory);
  const options = { brokerConfig: simulation.brokerConfig, marketData: simulation.marketData, clock: simulation.clock, formatters: stringFormatters, settings: mapSettings() };
  const live = createTradingSession({ ...options, brokerFactory: recorder.brokerFactory });
  await live.ready;
  const placed = await live.commands.place({ context: live.commands.context(), order: { symbol: 'SIM:X', side: 1, type: 1, qty: 1, limitPrice: 80 } });
  assert.equal(placed.outcome, 'confirmed');
  const expected = { orders: live.state.orders.ids().sort(), positions: live.state.positions.ids().sort() };
  live.destroy();
  const transcript = JSON.parse(JSON.stringify(recorder.transcript()));
  assert(transcript.events.some(event => event.kind === 'call' && event.method === 'placeOrder'));
  const replayed = createTradingSession({ ...options, brokerFactory: createReplayBroker(transcript) });
  await replayed.ready;
  const again = await replayed.commands.place({ context: replayed.commands.context(), order: { symbol: 'SIM:X', side: 1, type: 1, qty: 1, limitPrice: 80 } });
  assert.equal(again.outcome, 'confirmed');
  assert.deepEqual({ orders: replayed.state.orders.ids().sort(), positions: replayed.state.positions.ids().sort() }, expected);
  replayed.destroy();
});
test('X08/O02: the kit fails an adapter that declares BrokerRejection but loses the broker message', async () => {
  const setup = mockSetup();
  const report = await runConformance({
    name: 'plain errors', scenarios: ['O02'],
    setup: () => { const value = setup(); const reject = value.controls.rejectNext; return { ...value, controls: { ...value.controls, rejectNext: () => reject.call(null, 'other') } }; },
  });
  assert.equal(report.results[0].status, 'fail');
  assert.match(report.results[0].reason, /broker's message/);
});
