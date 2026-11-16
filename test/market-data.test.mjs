import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createTradingMarketData } = await loadModule('src/market-data/subscriptions.ts');
const { DepthBook } = await loadModule('src/market-data/depth-book.ts');
function providerFixture() {
  const initial = [], streams = [], released = [], depth = [], releasedDepth = [];
  const provider = {
    getQuotes: (symbols, callback, error) => initial.push({ symbols, callback, error }),
    subscribeQuotes: (normal, fast, callback, guid) => streams.push({ normal, fast, callback, guid }),
    unsubscribeQuotes: guid => released.push(guid),
    subscribeDepth: (symbol, callback) => { const guid = `depth-${depth.length}`; depth.push({ symbol, callback, guid }); return guid; },
    unsubscribeDepth: guid => releasedDepth.push(guid),
  };
  return { provider, initial, streams, released, depth, releasedDepth };
}
const quote = (symbol, price) => ({ n: symbol, s: 'ok', v: { lp: price, bid: price - 1, ask: price + 1 } });
test('D04: duplicate symbols share quote/depth demand; priorities consolidate and callbacks fence after release', async () => {
  const fixture = providerFixture(), port = createTradingMarketData(fixture.provider, () => 0.01), first = [], second = [];
  const release1 = port.acquireQuotes('X', 'normal', value => first.push(value));
  const release2 = port.acquireQuotes('X', 'fast', value => second.push(value)); await flush();
  assert.equal(fixture.streams.length, 1); assert.deepEqual(fixture.streams[0].fast, ['X']);
  fixture.initial[0].callback([quote('X', 10)]); assert.equal(first.at(-1).value.trade, 10); assert.equal(second.at(-1).value.trade, 10);
  release1(); await flush(); assert.equal(fixture.released.length, 0);
  release2(); release2(); fixture.streams[0].callback([quote('X', 99)]); assert.equal(second.at(-1).value.trade, 10); assert.equal(fixture.released.length, 1);
  const depth1 = port.acquireDepth('X', () => {}), depth2 = port.acquireDepth('X', () => {});
  assert.equal(fixture.depth.length, 1); depth1(); assert.equal(fixture.releasedDepth.length, 0); depth2(); assert.equal(fixture.releasedDepth.length, 1);
  port.destroy();
});
test('D01/D04: initial quotes cannot overwrite streamed or newer host updates; errors remain symbol-scoped', async () => {
  const fixture = providerFixture(), port = createTradingMarketData(fixture.provider, () => 0.01), x = [], y = [];
  port.acquireQuotes('X', 'fast', value => x.push(value)); port.acquireQuotes('Y', 'fast', value => y.push(value)); await flush();
  fixture.streams[0].callback([quote('X', 20)]); fixture.initial[0].callback([quote('X', 10)]);
  assert.equal(x.at(-1).value.trade, 20);
  fixture.initial[1].callback([{ n: 'Y', s: 'error', v: {} }]); assert.equal(y.at(-1).status, 'error'); assert.equal(x.at(-1).status, 'ready');
  port.destroy();
  const second = providerFixture(), newer = createTradingMarketData(second.provider, () => 0.01), received = [];
  newer.acquireQuotes('X', 'normal', value => received.push(value)); await flush(); second.streams[0].callback([quote('X', 20)]); newer.pushQuotes('X', { trade: 30 }); second.initial[0].callback([quote('X', 10)]);
  assert.equal(received.at(-1).value.trade, 30); newer.destroy();
});
test('D01: depth snapshots replace, deltas update/delete, tick prices normalize and unchanged levels retain identity', () => {
  const book = new DepthBook(0.01);
  assert.equal(book.apply({ snapshot: false, bids: [{ price: 10, volume: 99 }], asks: [] }), undefined);
  book.apply({ snapshot: true, bids: [{ price: 10, volume: 1 }, { price: 9, volume: 2 }], asks: [{ price: 11, volume: 3 }] });
  assert.equal(book.bids.get('10').volume, 1);
  const unchanged = book.asks.get('11'), changes = []; book.bids.subscribeChanges(change => changes.push(change));
  book.apply({ snapshot: false, bids: [{ price: 10.001, volume: 5 }, { price: 9, volume: 0 }], asks: [] });
  assert.equal(book.bids.get('10').volume, 5); assert.equal(book.bids.get('9'), undefined); assert.equal(book.asks.get('11'), unchanged);
  assert.deepEqual(changes[0].updated, ['10']); assert.deepEqual(changes[0].removed, ['9']);
  assert.throws(() => book.apply({ snapshot: true, bids: [{ price: 8, volume: 1 }], asks: [{ price: 12, volume: -1 }] }), /Invalid depth/);
  assert.equal(book.bids.get('10').volume, 5); book.destroy();
});
test('D01: pre-snapshot depth overflow restarts once and stale prior subscription callbacks cannot mutate the book', async () => {
  const fixture = providerFixture(), diagnostics = [], port = createTradingMarketData(fixture.provider, () => 1, message => diagnostics.push(message)), events = [];
  port.acquireDepth('X', value => events.push(value));
  for (let i = 0; i < 1001; i++) fixture.depth[0].callback({ snapshot: false, bids: [{ price: 10, volume: i }], asks: [] });
  await flush(); assert.equal(fixture.depth.length, 2); assert.equal(fixture.releasedDepth.length, 1); assert.equal(diagnostics.length, 1);
  fixture.depth[0].callback({ snapshot: true, bids: [{ price: 99, volume: 1 }], asks: [] }); assert.equal(events.length, 0);
  fixture.depth[1].callback({ snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] }); assert.equal(events.length, 1); port.destroy();
});

test('D01/D04: live quotes publish before a stalled initial read and its late error cannot clear them', async () => {
  const f = providerFixture(), port = createTradingMarketData(f.provider, () => .01), events = [];
  port.acquireQuotes('X', 'fast', value => events.push(value)); await flush();
  f.streams[0].callback([quote('X', 20)]);
  assert.equal(events.at(-1).source, 'stream'); assert.equal(events.at(-1).value.trade, 20);
  f.initial[0].error(); assert.equal(events.at(-1).status, 'ready'); assert.equal(events.at(-1).value.trade, 20);
  const replay = []; port.acquireQuotes('X', 'fast', value => replay.push(value));
  assert.equal(replay[0].source, 'snapshot'); assert.equal(replay[0].value.trade, 20); port.destroy();
});
test('D01/Q01: datafeed quote values map last price, bid, ask and spread; display-only fields stay out of trading quotes', async () => {
  const fixture = providerFixture(), port = createTradingMarketData(fixture.provider, () => 0.01), received = [];
  port.acquireQuotes('X', 'fast', value => received.push(value)); await flush();
  fixture.streams[0].callback([{ n: 'X', s: 'ok', v: { lp: 101.5, bid: 101.4, ask: 101.6, spread: 0.2, ch: 1.5, chp: 1.5, open_price: 100, high_price: 102, low_price: 99, prev_close_price: 100, volume: 5000, short_name: 'X', exchange: 'SIM', description: 'Sim', original_name: 'SIM:X', rtc: 101.7, rtc_time: 1700000000, rch: 0.2, rchp: 0.2 } }]);
  assert.deepEqual({ ...received.at(-1).value }, { trade: 101.5, bid: 101.4, ask: 101.6, spread: 0.2 });
  fixture.streams[0].callback([{ n: 'X', s: 'error', v: {} }]);
  assert.equal(received.at(-1).status, 'error');
  port.destroy();
});

test('D04: repeated depth callback ownership keeps the existing deduplicated subscription lifetime', () => {
  const f = providerFixture(), port = createTradingMarketData(f.provider, () => 0.01);
  const callback = () => {};
  const first = port.acquireDepth('X', callback), duplicate = port.acquireDepth('X', callback);
  assert.equal(f.depth.length, 1);
  first(); duplicate(); assert.deepEqual(f.releasedDepth, ['depth-0']);
  port.destroy(); assert.deepEqual(f.releasedDepth, ['depth-0']);
});

test('D04/A05: datafeed teardown preserves quote-before-depth release order after provider failures', async () => {
  const f = providerFixture(), calls = [], failure = new Error('unsubscribe failed');
  f.provider.unsubscribeQuotes = guid => { calls.push('quote'); throw failure; };
  f.provider.unsubscribeDepth = guid => calls.push('depth');
  const port = createTradingMarketData(f.provider, () => 0.01);
  port.acquireQuotes('X', 'fast', () => {}); port.acquireQuotes('Y', 'fast', () => {});
  port.acquireDepth('X', () => {}); await flush();
  assert.throws(() => port.destroy(), error => error === failure);
  assert.deepEqual(calls, ['quote', 'quote', 'depth']);
  port.destroy(); assert.equal(calls.length, 3);
});

test('D04/A05: failed depth setup rolls back ownership so a retry can subscribe and release normally', () => {
  const f = providerFixture(), events = [], failed = [], subscribe = f.provider.subscribeDepth;
  let attempt = 0;
  f.provider.subscribeDepth = (...args) => {
    if (++attempt === 1) throw new Error('depth setup failed');
    return subscribe(...args);
  };
  const port = createTradingMarketData(f.provider, () => 0.01);
  assert.throws(() => port.acquireDepth('X', value => failed.push(value)), /depth setup failed/);
  const release = port.acquireDepth('X', value => events.push(value));
  assert.equal(f.depth.length, 1, 'a failed attempt cannot leave depth stuck in starting');
  f.depth[0].callback({ snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] });
  assert.equal(events.length, 1);
  assert.equal(failed.length, 0);
  release();
  assert.deepEqual(f.releasedDepth, ['depth-0']);
  port.destroy();
});

test('D04/A05: failed initial quote delivery cannot retain a consumer or its speed preference', async () => {
  const f = providerFixture(), port = createTradingMarketData(f.provider, () => 0.01);
  assert.throws(() => port.acquireQuotes('X', 'fast', () => { throw new Error('consumer failed'); }), /consumer failed/);
  const release = port.acquireQuotes('X', 'normal', () => {});
  await flush();
  assert.deepEqual(f.streams[0].normal, ['X']);
  assert.deepEqual(f.streams[0].fast, []);
  release();
  assert.deepEqual(f.released, [f.streams[0].guid]);
  port.destroy();
});
test('D02: a depth restart whose provider throws reports a diagnostic and the next acquisition restarts', async () => {
  const fixture = providerFixture(), diagnostics = [], subscribe = fixture.provider.subscribeDepth;
  let failRestart = false;
  fixture.provider.subscribeDepth = (...args) => {
    if (failRestart) { failRestart = false; throw new Error('restart failed'); }
    return subscribe(...args);
  };
  const port = createTradingMarketData(fixture.provider, () => 1, message => diagnostics.push(message));
  const release = port.acquireDepth('X', () => {});
  failRestart = true;
  for (let i = 0; i < 1001; i++) fixture.depth[0].callback({ snapshot: false, bids: [{ price: 10, volume: i }], asks: [] });
  await flush();
  assert.equal(fixture.depth.length, 1);
  assert(diagnostics.some(message => message.includes('restart failed')));
  const events = [];
  const second = port.acquireDepth('X', value => events.push(value));
  assert.equal(fixture.depth.length, 2, 'the next acquisition restarts the subscription');
  fixture.depth[1].callback({ snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] });
  assert.equal(events.length, 1);
  second(); release(); port.destroy();
});
