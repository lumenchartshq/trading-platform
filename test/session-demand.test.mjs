import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { createSessionDemand } = await loadModule('src/market-data/session-demand.ts');
const { createTradingState } = await loadModule('src/core/trading-state.ts');

test('D04: shared quote delivery skips released consumers and contains listener failures', () => {
  const state = createTradingState(), errors = [], received = [];
  let send, releaseSecond;
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) { send = callback; return () => {}; },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => errors.push(error));
  demand.resume();
  demand.acquireQuotes('X', 'normal', () => { releaseSecond(); throw new Error('consumer failed'); });
  releaseSecond = demand.acquireQuotes('X', 'normal', () => received.push('released'));
  demand.acquireQuotes('X', 'normal', () => received.push('remaining'));
  assert.doesNotThrow(() => send({ status: 'ready', source: 'stream', value: { trade: 10 } }));
  assert.deepEqual(received, ['remaining']);
  assert.equal(errors.length, 1);
  demand.destroy(); state.destroy();
});

test('D04/A05: depth replay cannot acquire a provider after its last consumer releases', async () => {
  const state = createTradingState(), errors = [];
  let resolveInfo, starts = 0, stops = 0, release;
  const demand = createSessionDemand({
    acquireQuotes() { return () => {}; },
    acquireDepth() { starts++; return () => { stops++; }; },
  }, state, () => ({}), () => new Promise(resolve => { resolveInfo = resolve; }), error => errors.push(error));
  demand.resume();
  release = demand.acquireDepth('X', () => release());
  demand.hostDepth('X', { snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] });
  resolveInfo({ minTick: 1 });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(starts, stops, 'no orphaned provider lease remains');
  assert.deepEqual(errors, []);
  demand.destroy(); state.destroy();
});
test('D04: shared depth delivery skips released listeners and continues after a failure', async () => {
  const state = createTradingState(), errors = [], received = [];
  let send, releaseSecond;
  const demand = createSessionDemand({
    acquireQuotes() { return () => {}; },
    acquireDepth(_symbol, callback) { send = callback; return () => {}; },
  }, state, () => ({}), async () => ({ minTick: 1 }), error => errors.push(error));
  demand.resume();
  demand.acquireDepth('X', () => { releaseSecond(); throw new Error('consumer failed'); });
  releaseSecond = demand.acquireDepth('X', () => received.push('released'));
  demand.acquireDepth('X', () => received.push('remaining'));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  send({ snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] });
  assert.deepEqual(received, ['remaining']); assert.equal(errors.length, 1);
  demand.destroy(); state.destroy();
});
test('D04/A05: synchronous depth setup that suspends releases its provider lease', async () => {
  const state = createTradingState(), errors = [];
  let stops = 0, demand;
  demand = createSessionDemand({
    acquireQuotes() { return () => {}; },
    acquireDepth() { demand.suspend(); return () => { stops++; }; },
  }, state, () => ({}), async () => ({ minTick: 1 }), error => errors.push(error));
  demand.resume(); demand.acquireDepth('X', () => {});
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(stops, 1); assert.deepEqual(errors, []);
  demand.destroy(); state.destroy();
});
test('D02: an invalid synchronous depth update does not prevent later valid updates', async () => {
  const state = createTradingState(), errors = [], received = [];
  let send, stops = 0;
  const demand = createSessionDemand({
    acquireQuotes() { return () => {}; },
    acquireDepth(_symbol, callback) {
      send = callback;
      callback({ snapshot: true, bids: [{ price: 10, volume: -1 }], asks: [] });
      return () => { stops++; };
    },
  }, state, () => ({}), async () => ({ minTick: 1 }), error => errors.push(error));
  demand.resume(); const release = demand.acquireDepth('X', value => received.push(value));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  send({ snapshot: true, bids: [{ price: 11, volume: 2 }], asks: [] });
  assert.equal(errors.length, 1); assert.equal(received.at(-1)?.bids[0].price, 11);
  const joined = []; const releaseJoined = demand.acquireDepth('X', value => joined.push(value));
  assert.equal(joined[0]?.bids[0]?.price, 11);
  releaseJoined(); release(); assert.equal(stops, 1); demand.destroy(); state.destroy();
});

test('D01/X09: host quote arbitration among10000 symbols reads one record and ignores stale snapshot work', () => {
  const state = createTradingState();
  state.quotes.replace(Array.from({ length: 10000 }, (_, i) => ({ id: `S${i}`, trade: 1 })));
  const callbacks = new Map();
  const demand = createSessionDemand({
    acquireQuotes(symbol, _speed, listener) { callbacks.set(symbol, listener); return () => callbacks.delete(symbol); },
    acquireDepth() { throw new Error('Unexpected depth demand'); },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  const first = [], other = [], changes = [];
  demand.acquireQuotes('S0', 'fast', value => first.push(value));
  demand.acquireQuotes('S1', 'fast', value => other.push(value)); demand.resume();
  first.length = 0; other.length = 0;
  let gets = 0, ids = 0;
  const get = state.quotes.get.bind(state.quotes), all = state.quotes.ids.bind(state.quotes);
  state.quotes.get = id => { gets++; return get(id); };
  state.quotes.ids = () => { ids++; return all(); };
  state.quotes.subscribeChanges(change => changes.push(change));
  demand.hostQuotes('S0', { trade: 30 });
  callbacks.get('S0')({ status: 'ready', source: 'snapshot', value: { trade: 10 } });
  assert.equal(gets, 1); assert.equal(ids, 0); assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].updated, ['S0']); assert.equal(first.length, 1);
  assert.equal(first[0].value.trade, 30); assert.equal(other.length, 0);
  assert.equal(get('S0').trade, 30); assert.equal(get('S1').trade, 1);
  demand.destroy(); state.destroy(); assert.equal(callbacks.size, 0);
});

test('P03/A05: failed financial acquisition rolls back provider setup and reference counts for every channel', () => {
  for (const [kind, subscribe, unsubscribe] of [
    ['equity', 'subscribeEquity', 'unsubscribeEquity'], ['margin', 'subscribeMarginAvailable', 'unsubscribeMarginAvailable'], ['pip', 'subscribePipValue', 'unsubscribePipValue'],
  ]) {
    const state = createTradingState(), calls = [];
    let fail = true;
    const broker = { [subscribe](...args) { calls.push(['start', ...args]); if (fail) throw new Error('start failed'); }, [unsubscribe](...args) { calls.push(['stop', ...args]); } };
    const demand = createSessionDemand({ acquireQuotes() { return () => {}; }, acquireDepth() { return () => {}; } }, state, () => broker, async () => ({}), error => { throw error; });
    demand.resume(); assert.throws(() => demand.acquireFinancial(kind, 'X'), /start failed/);
    fail = false;
    const first = demand.acquireFinancial(kind, 'X'), second = demand.acquireFinancial(kind, 'X');
    assert.equal(calls.filter(([method]) => method === 'start').length, 2);
    first(); assert.equal(calls.filter(([method]) => method === 'stop').length, 1);
    second(); second(); assert.equal(calls.filter(([method]) => method === 'stop').length, 2);
    assert.deepEqual(calls[0].slice(1), kind === 'equity' ? [] : ['X']);
    demand.destroy(); state.destroy(); assert.equal(calls.length, 4);
  }
});

test('P03/A05: resume and refresh subscription failures retain only real owners and preserve cleanup errors', () => {
  const state = createTradingState(), errors = [];
  let starts = 0, stops = 0, fail = true, failCleanup = false;
  const broker = { subscribePipValue() { starts++; if (fail) throw new Error('start failed'); }, unsubscribePipValue() { stops++; if (failCleanup) throw new Error('cleanup failed'); } };
  const demand = createSessionDemand({ acquireQuotes() { return () => {}; }, acquireDepth() { return () => {}; } }, state, () => broker, async () => ({}), error => errors.push(error));
  const first = demand.acquireFinancial('pip', 'X'); demand.resume();
  assert.equal(errors.length, 1); assert.equal(starts, 1); assert.equal(stops, 1);
  fail = false; const second = demand.acquireFinancial('pip', 'X');
  assert.equal(starts, 2); second(); assert.equal(stops, 1);
  fail = true; demand.refreshFinancial('X'); assert.equal(errors.length, 2);
  assert.equal(starts, 3); assert.equal(stops, 3);
  fail = false; demand.refreshFinancial('X'); first();
  assert.equal(starts, 4); assert.equal(stops, 4);
  fail = true; failCleanup = true;
  assert.throws(() => demand.acquireFinancial('pip', 'Y'), error => error instanceof AggregateError && error.errors[0].message === 'start failed' && error.errors[1].message === 'cleanup failed');
  fail = false; failCleanup = false;
  const retry = demand.acquireFinancial('pip', 'Y'); retry();
  assert.equal(starts, 6); assert.equal(stops, 6);
  demand.destroy(); state.destroy(); assert.equal(stops, 6);
});

test('D01/P01: new consumers retain the latest live quote error and cached snapshot data cannot restore stale money', () => {
  const state = createTradingState(), callbacks = [];
  const demand = createSessionDemand({ acquireQuotes(_symbol, _speed, callback) { callbacks.push(callback); return () => {}; }, acquireDepth() { return () => {}; } }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.acquireQuotes('X', 'normal', () => {}); demand.resume();
  demand.hostQuotes('X', { trade: 30 });
  callbacks[0]({ status: 'error', source: 'stream', error: 'Unavailable' });
  const second = []; demand.acquireQuotes('X', 'normal', value => second.push(value));
  assert.equal(second.at(-1).status, 'error');
  assert.equal(callbacks.length, 1, 'consumers share one provider lease');
  callbacks[0]({ status: 'ready', source: 'snapshot', value: { trade: 10 } });
  assert.equal(second.at(-1).status, 'error');
  const mutable = { status: 'ready', source: 'stream', value: { trade: 50 } };
  callbacks[0](mutable); mutable.value.trade = 999;
  const third = []; demand.acquireQuotes('X', 'normal', value => third.push(value));
  assert.equal(third.at(-1).value.trade, 50); assert(Object.isFrozen(third.at(-1).value));
  demand.destroy(); state.destroy();
});

test('D04/A05: released quote callbacks are fenced before provider cleanup and after reacquisition', () => {
  const state = createTradingState(), callbacks = [], delivered = [];
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) {
      callbacks.push(callback);
      return () => callback({ status: 'ready', value: { trade: 999 } });
    },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.resume();
  const release = demand.acquireQuotes('X', 'normal', value => delivered.push(value));
  callbacks[0]({ status: 'ready', value: { trade: 10 } });
  release(); release();
  assert.equal(delivered.length, 1, 'cleanup cannot deliver into a released consumer');
  const second = [];
  const releaseSecond = demand.acquireQuotes('X', 'normal', value => second.push(value));
  callbacks[1]({ status: 'ready', value: { trade: 20 } });
  callbacks[0]({ status: 'ready', value: { trade: 30 } });
  assert.equal(state.quotes.get('X').trade, 20, 'a retired subscription cannot overwrite the new subscription');
  assert.equal(delivered.length, 1);
  releaseSecond(); demand.destroy(); state.destroy();
});

test('D04/A05: failed quote setup releases local ownership and fences callbacks from the failed attempt', () => {
  const state = createTradingState(), callbacks = [];
  let fail = true, stops = 0;
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) {
      callbacks.push(callback);
      if (fail) throw new Error('setup failed');
      return () => { stops++; };
    },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.resume();
  assert.throws(() => demand.acquireQuotes('X', 'normal', () => {}), /setup failed/);
  callbacks[0]({ status: 'ready', value: { trade: 999 } });
  assert.equal(state.quotes.get('X'), undefined);
  fail = false;
  const release = demand.acquireQuotes('X', 'normal', () => {});
  release(); demand.suspend(); demand.resume();
  assert.equal(callbacks.length, 2, 'failed consumers must not be restarted');
  assert.equal(stops, 1);
  demand.destroy(); state.destroy();
});

test('D04/P01: live port updates and errors survive late initial snapshots and cached consumer replays', () => {
  const state = createTradingState(), callbacks = [], first = [], second = [];
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) { callbacks.push(callback); return () => {}; },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.resume();
  demand.acquireQuotes('X', 'normal', value => first.push(value));
  callbacks[0]({ status: 'ready', source: 'stream', value: { trade: 20 } });
  callbacks[0]({ status: 'ready', source: 'snapshot', value: { trade: 10 } });
  assert.equal(state.quotes.get('X').trade, 20);
  callbacks[0]({ status: 'error', source: 'stream', error: 'Disconnected' });
  demand.acquireQuotes('X', 'normal', value => second.push(value));
  assert.equal(second.at(-1).status, 'error');
  assert.equal(callbacks.length, 1, 'consumers share one provider lease');
  callbacks[0]({ status: 'ready', source: 'snapshot', value: { trade: 10 } });
  assert.equal(second.at(-1).status, 'error');
  callbacks[0]({ status: 'ready', value: { trade: 30 } });
  assert.equal(state.quotes.get('X').trade, 30, 'an omitted source remains an authoritative live update');
  demand.destroy(); state.destroy();
});

test('D04/A05: synchronous quote delivery can suspend demand without leaking the returned disposer', () => {
  const state = createTradingState();
  let stops = 0;
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) {
      callback({ status: 'ready', value: { trade: 20 } });
      return () => { stops++; };
    },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.resume();
  const release = demand.acquireQuotes('X', 'normal', () => demand.suspend());
  assert.equal(stops, 1);
  release(); demand.destroy(); state.destroy();
  assert.equal(stops, 1);
});

test('P03/X09: consumers of one symbol share one provider lease; one tick is one store write and one call per consumer', () => {
  const state = createTradingState(), acquisitions = [], releases = [];
  const demand = createSessionDemand({
    acquireQuotes(symbol, speed, callback) { acquisitions.push({ symbol, speed, callback }); return () => releases.push(speed); },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.resume();
  const received = [[], [], []];
  const leases = received.map(list => demand.acquireQuotes('X', 'normal', value => list.push(value)));
  assert.equal(acquisitions.length, 1);
  let writes = 0; state.quotes.subscribeChanges(() => writes++);
  acquisitions[0].callback({ status: 'ready', value: { trade: 10 } });
  assert.equal(writes, 1);
  assert.deepEqual(received.map(list => list.length), [1, 1, 1]);
  assert.equal(received[0][0], received[2][0], 'every consumer receives the same frozen snapshot');
  const fast = demand.acquireQuotes('X', 'fast', () => {});
  assert.deepEqual(acquisitions.map(value => value.speed), ['normal', 'fast'], 'a fast consumer re-acquires at fast speed');
  assert.deepEqual(releases, ['normal']);
  fast();
  assert.deepEqual(acquisitions.map(value => value.speed), ['normal', 'fast', 'normal']);
  for (const release of leases) release();
  assert.deepEqual(releases, ['normal', 'fast', 'normal'], 'the last consumer releases the provider lease');
  demand.destroy(); state.destroy();
});
test('A03: host quotes during suspension are ignored and cannot mark the symbol live for the next epoch', () => {
  const state = createTradingState(), callbacks = [];
  const demand = createSessionDemand({
    acquireQuotes(_symbol, _speed, callback) { callbacks.push(callback); return () => {}; },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => { throw error; });
  demand.acquireQuotes('X', 'normal', () => {});
  demand.resume(); demand.suspend();
  demand.hostQuotes('X', { trade: 99 });
  assert.equal(state.quotes.get('X'), undefined);
  demand.resume();
  callbacks.at(-1)({ status: 'ready', source: 'snapshot', value: { trade: 10 } });
  assert.equal(state.quotes.get('X').trade, 10, 'the new epoch snapshot is not shadowed by a suspended push');
  demand.destroy(); state.destroy();
});
test('D02: depth acquisition failing after instrument metadata keeps no book and a retry starts one', async () => {
  const state = createTradingState(), errors = [], subscriptions = [];
  let fail = true;
  const demand = createSessionDemand({
    acquireQuotes() { return () => {}; },
    acquireDepth(_symbol, callback) {
      if (fail) throw new Error('depth failed');
      subscriptions.push(callback); return () => {};
    },
  }, state, () => ({}), async () => ({ minTick: 1 }), error => errors.push(error));
  demand.resume();
  const first = [];
  const release = demand.acquireDepth('X', value => first.push(value));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(errors.length, 1);
  demand.hostDepth('X', { snapshot: true, bids: [{ price: 10, volume: 1 }], asks: [] });
  assert.equal(first.length, 0, 'no stale book was retained');
  fail = false;
  const second = [];
  const retry = demand.acquireDepth('X', value => second.push(value));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(subscriptions.length, 1);
  assert.equal(second.length, 1, 'the buffered snapshot replays into the one new book');
  subscriptions[0]({ snapshot: false, bids: [{ price: 11, volume: 2 }], asks: [] });
  assert.equal(second.length, 2);
  retry(); release(); demand.destroy(); state.destroy();
});
test('P03/D04: a failed speed change keeps the existing quote stream and never throws at consumers', () => {
  const state = createTradingState(), callbacks = [], errors = [];
  let failFast = true, failRelease = false;
  const demand = createSessionDemand({
    acquireQuotes(_symbol, speed, callback) {
      if (speed === 'fast' && failFast) throw new Error('fast unavailable');
      callbacks.push(callback);
      return () => { if (failRelease) throw new Error('release failed'); };
    },
    acquireDepth() { return () => {}; },
  }, state, () => ({}), async () => ({}), error => errors.push(error));
  demand.resume();
  const normal = [];
  demand.acquireQuotes('X', 'normal', value => normal.push(value));
  let releaseFast;
  assert.doesNotThrow(() => { releaseFast = demand.acquireQuotes('X', 'fast', () => {}); });
  assert.equal(errors.length, 1, 'the failed upgrade is reported');
  callbacks[0]({ status: 'ready', value: { trade: 10 } });
  assert.equal(normal.at(-1).value.trade, 10, 'the original stream still serves its consumers');
  failFast = false; releaseFast();
  const again = demand.acquireQuotes('X', 'fast', () => {});
  assert.equal(callbacks.length, 2, 'the upgrade succeeds once the provider allows it');
  failRelease = true;
  assert.doesNotThrow(() => again(), 'a failing provider release during the downgrade is reported, not thrown');
  assert(errors.length >= 2);
  const reported = errors.length;
  const last = demand.acquireQuotes('Y', 'normal', () => {});
  assert.doesNotThrow(() => last(), 'the last consumer releasing a failing provider lease does not throw');
  assert.equal(errors.length, reported + 1);
  demand.destroy(); state.destroy();
});
