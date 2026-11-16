import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred, flush } from './manual-clock.mjs';
const { createPositionEstimates } = await loadModule('src/core/position-estimates.ts');
const { createTradingState } = await loadModule('src/core/trading-state.ts');
const instrument = { minTick: .01, pipSize: .1, pipValue: 5, description: 'Example', qty: { min: 1, max: 10000, step: 1 } };
const position = { id: 'L', symbol: 'X', side: 1, qty: 2, avgPrice: 100, extra: { pl: 999 } };
function fixture(rows = [position], metadata = async () => instrument, individual = false) {
  const state = createTradingState(), quotes = new Map(), pips = new Map(), calls = [], errors = [];
  state.connection.set({ status: 1, phase: 'ready', generation: 1, accountId: 'A' });
  const source = individual ? state.individualPositions : state.positions;
  source.replace(rows);
  const session = {
    state, symbolInfo: symbol => { calls.push(['info', symbol]); return metadata(symbol); },
    acquireQuotes(symbol, speed, listener) {
      calls.push(['quotes', symbol, speed]); quotes.set(symbol, listener);
      listener({ status: 'ready', value: { bid: 101, ask: 102 } });
      return () => { quotes.delete(symbol); calls.push(['release-quotes', symbol]); };
    },
    acquireFinancial(kind, symbol) {
      assert.equal(kind, 'pip'); calls.push(['pip', symbol]); pips.set(symbol, true);
      return () => { pips.delete(symbol); calls.push(['release-pip', symbol]); };
    },
  };
  const estimates = createPositionEstimates(session, source, individual, error => errors.push(error));
  return { state, source, quotes, pips, calls, errors, estimates, destroy() { estimates.destroy(); state.destroy(); } };
}

test('P01/P02: money estimates share symbol demand, respect side pip values and never overwrite broker money', async () => {
  const f = fixture([position, { ...position, id: 'S', side: -1, qty: 3 }]);
  assert.equal(f.quotes.size, 0); f.estimates.setActive(true); await flush();
  assert.equal(f.quotes.size, 1); assert.equal(f.pips.size, 1);
  assert.equal(f.estimates.reader.get('L').value, 100); assert.equal(f.estimates.reader.get('S').value, -300);
  assert.equal(f.source.get('L').extra.pl, 999);
  f.state.pipValues.upsert({ id: 'X', buyPipValue: 2, sellPipValue: 4 });
  assert.equal(f.estimates.reader.get('L').value, 40); assert.equal(f.estimates.reader.get('S').value, -240);
  f.quotes.get('X')({ status: 'error' }); assert.equal(f.estimates.reader.get('L'), undefined);
  f.quotes.get('X')({ status: 'ready', value: { bid: 100, ask: 101 } });
  assert.equal(f.estimates.reader.get('L').value, 0); assert.equal(f.estimates.reader.get('S').value, -120);
  f.source.remove('S'); assert.equal(f.quotes.size, 1);
  f.source.remove('L'); assert.equal(f.quotes.size, 0); assert.equal(f.pips.size, 0);
  f.destroy(); assert.deepEqual(f.errors, []);
});

test('P01/A03/A05: account invalidation and hidden consumers release demand and fence late metadata/quotes', async () => {
  const requests = [];
  const f = fixture([position], () => { const request = deferred(); requests.push(request); return request.promise; });
  f.estimates.setActive(true); const staleQuote = f.quotes.get('X');
  f.state.connection.set({ status: 1, phase: 'hydrating', generation: 2, accountId: 'B' });
  assert.equal(f.quotes.size, 0); assert.equal(f.pips.size, 0); assert.deepEqual(f.estimates.reader.ids(), []);
  f.source.replace([{ ...position, id: 'B' }]);
  f.state.connection.set({ status: 1, phase: 'ready', generation: 2, accountId: 'B' });
  assert.equal(requests.length, 2);
  requests[0].resolve({ ...instrument, pipValue: 999 }); staleQuote({ status: 'ready', value: { bid: 999 } }); await flush();
  assert.deepEqual(f.estimates.reader.ids(), []);
  requests[1].resolve(instrument); await flush(); assert.equal(f.estimates.reader.get('B').value, 100);
  const late = f.quotes.get('X'); f.estimates.setActive(false);
  assert.equal(f.quotes.size, 0); assert.equal(f.pips.size, 0); assert.deepEqual(f.estimates.reader.ids(), []);
  late({ status: 'ready', value: { bid: 999 } }); assert.deepEqual(f.estimates.reader.ids(), []);
  f.destroy(); f.estimates.setActive(true); assert.equal(f.quotes.size, 0);
});

test('P01/P04: individual price is the entry basis and failed/zero-value metadata never fabricates profit', async () => {
  const row = { id: 'I', symbol: 'X', side: 1, qty: 2, price: 100, date: 1, pl: 999 };
  const f = fixture([row], async () => instrument, true); f.estimates.setActive(true); await flush();
  assert.equal(f.estimates.reader.get('I').value, 100); assert.equal(f.source.get('I').pl, 999); f.destroy();
  for (const metadata of [async () => ({ ...instrument, pipValue: 0 }), async () => ({ ...instrument, pipSize: 0 }), async () => { throw new Error('Metadata unavailable'); }]) {
    const unavailable = fixture([position], metadata); unavailable.estimates.setActive(true); await flush();
    assert.equal(unavailable.estimates.reader.get('L'), undefined); unavailable.destroy();
    assert.equal(unavailable.quotes.size, 0); assert.equal(unavailable.pips.size, 0);
  }
});

test('P01/X09: quote work among10000 positions is limited to its100 matching positions with no ID-list scan', async () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({ ...position, id: String(i), symbol: `S${i % 100}` }));
  const f = fixture(rows); f.estimates.setActive(true); await flush();
  assert.equal(f.quotes.size, 100); assert.equal(f.pips.size, 100);
  let gets = 0, ids = 0;
  const get = f.source.get.bind(f.source), all = f.source.ids.bind(f.source);
  f.source.get = id => { gets++; return get(id); }; f.source.ids = () => { ids++; return all(); };
  const events = []; f.estimates.reader.subscribeChanges(change => events.push(change));
  f.quotes.get('S0')({ status: 'ready', value: { bid: 103, ask: 104 } });
  assert.equal(gets, 100); assert.equal(ids, 0); assert.equal(events.length, 1);
  assert.equal(events[0].updated.length, 100); assert(events[0].updated.every(id => Number(id) % 100 === 0));
  assert.equal(f.estimates.reader.get('0').value, 300); assert.equal(f.estimates.reader.get('1').value, 100);
  f.destroy(); assert.equal(f.quotes.size, 0); assert.equal(f.pips.size, 0);
});

test('P02/P03: tick and percentage modes ignore money/pip updates and retain quotes while switching pip demand', async () => {
  const f = fixture(); f.estimates.setMode('ticks'); f.estimates.setActive(true); await flush();
  assert.equal(f.estimates.reader.get('L').value, 10); assert.equal(f.pips.size, 0); assert.equal(f.quotes.size, 1);
  const events = []; f.estimates.reader.subscribeChanges(change => events.push(change));
  f.state.pipValues.upsert({ id: 'X', buyPipValue: 9999, sellPipValue: 9999 }); assert.equal(events.length, 0);
  f.estimates.setMode('percentage'); assert.equal(f.estimates.reader.get('L').value, 1); assert.equal(f.pips.size, 0);
  f.estimates.setMode('money'); assert.equal(f.pips.size, 1); assert.equal(f.estimates.reader.get('L').value, 199980);
  f.estimates.setMode('ticks'); assert.equal(f.pips.size, 0); assert.equal(f.quotes.size, 1);
  assert.throws(() => f.estimates.setMode('wrong'), { code: 'invalid-input' }); f.destroy();
});
