import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred } from './manual-clock.mjs';
const { Delegate } = await loadModule('src/compat/delegate.ts');
const { WatchedValue } = await loadModule('src/compat/watched-value.ts');
const { DisposalScope } = await loadModule('src/core/disposal.ts');
const { EntityStore } = await loadModule('src/core/entity-store.ts');
const { createTradingState } = await loadModule('src/core/trading-state.ts');

test('U08: delegates bind receiver, remove once before reentrancy and respect removal during fire', () => {
  const delegate = new Delegate();
  const owner = { count: 0 };
  function once(value) { this.count += value; delegate.fire(100); }
  const removed = () => assert.fail('removed listener fired');
  delegate.subscribe(owner, once, true);
  delegate.subscribe(null, () => delegate.unsubscribe(owner, removed));
  delegate.subscribe(owner, removed);
  delegate.fire(2);
  assert.equal(owner.count, 2);
  delegate.unsubscribeAll(null);
  delegate.destroy(); delegate.destroy();
  delegate.subscribe(null, () => assert.fail('destroyed delegate fired'));
  delegate.fire(1);
});
test('U08: watched once/callWithLast/when, equality and forced changes', () => {
  const value = new WatchedValue(false);
  const events = [];
  value.when(v => events.push(['when', v]));
  value.subscribe(v => events.push(['last', v]), { once: true, callWithLast: true });
  value.setValue(false); value.setValue(true); value.setValue(true);
  assert.deepEqual(events, [['last', false], ['when', true]]);
  const changed = [];
  value.subscribe(v => changed.push(v));
  value.setValue(true, true); value.unsubscribe(null); value.setValue(false);
  assert.deepEqual(changed, [true]);
  value.destroy(); value.destroy(); value.setValue(true);
  assert.equal(value.value(), false);
});
test('U08: watched subscriptions installed during notification wait for the next event', () => {
  const value = new WatchedValue(0), events = [];
  value.subscribe(() => { value.subscribe(v => events.push(v)); throw new Error('listener'); }, { once: true });
  value.subscribe(v => events.push(v * 10));
  assert.throws(() => value.setValue(1), /listener/);
  assert.deepEqual(events, [10]);
  value.setValue(2); assert.deepEqual(events, [10, 20, 2]);
});
test('A05: scope cleans up in reverse order, continues on failure and destroys once', () => {
  const scope = new DisposalScope(), calls = [];
  scope.own(() => calls.push(1));
  scope.own(() => { calls.push(2); throw new Error('cleanup'); });
  scope.own(() => calls.push(3));
  assert.throws(() => scope.destroy(), /cleanup/);
  scope.destroy(); scope.own(() => calls.push(4));
  assert.deepEqual(calls, [3, 2, 1, 4]);
});
test('A04/X09: entity changes are immutable, batched, granular and proportional to the changed entity', () => {
  let validations = 0;
  const store = new EntityStore(row => { validations++; assert.equal(typeof row.id, 'string'); });
  store.replace(Array.from({ length: 10000 }, (_, i) => ({ id: String(i), extra: { score: 0 } })));
  const ids = store.ids(), untouched = store.get('1'), events = [];
  store.subscribeChanges(change => events.push(change)); validations = 0;
  const input = { id: '0', extra: { score: 42 } };
  store.upsert(input); input.extra.score = 99;
  assert.equal(validations, 1); assert.equal(store.get('0').extra.score, 42);
  assert.equal(store.get('1'), untouched); assert.equal(store.ids(), ids);
  assert.throws(() => { store.get('0').extra.score = 3; }, TypeError);
  assert.deepEqual(events[0].updated, ['0']);
  const revision = store.revision('0');
  store.upsert({ id: '0', extra: { score: 42 } });
  assert.equal(events.length, 1); assert.equal(store.revision('0'), revision);
  store.transaction(() => { store.patch('0', { extra: { score: 4 } }); store.patch('1', { extra: { score: 5 } }); });
  assert.equal(events.length, 2); assert.deepEqual(events[1].updated, ['0', '1']);
  assert.equal(store.patch('missing', { extra: {} }), false);
  assert.throws(() => store.patch('0', { id: 'new' }), /identity/);
  store.remove('0'); assert(store.revision('0') > revision);
  store.destroy(); store.upsert({ id: 'new' }); assert.equal(store.ids().length, 0);
});
test('P01: table-only PL and extra.pl remain distinct; zero quantity removes positions and retains revisions', () => {
  const state = createTradingState();
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 20, extra: { pl: 4 } };
  state.positionUpdate(position); state.tablePL.upsert({ id: 'P', value: 8 });
  assert.equal(state.positions.get('P').extra.pl, 4); assert.equal(state.tablePL.get('P').value, 8);
  state.positionUpdate({ ...position, extra: { pl: 6 } });
  assert.equal(state.tablePL.get('P').value, 8);
  const revision = state.positions.revision('P');
  state.positionUpdate({ ...position, qty: 0 });
  assert.equal(state.positions.get('P'), undefined); assert(state.positions.revision('P') > revision);
  state.destroy();
});
test('A04: terminal orders resist normal regressing pushes but explicit refresh can replace them', () => {
  const state = createTradingState();
  const order = { id: 'O', symbol: 'X', side: 1, qty: 2, type: 1, status: 2 };
  state.orders.upsert(order); state.orders.upsert({ ...order, status: 6 });
  assert.equal(state.orders.get('O').status, 2);
  state.orders.replace([{ ...order, status: 6 }]); assert.equal(state.orders.get('O').status, 6);
  assert.throws(() => state.orders.patch('O', { qty: NaN }), /quantity/);
  state.destroy();
});
test('A04: invalid snapshots are atomic and executable extra data is rejected without invoking getters', () => {
  const store = new EntityStore(row => { if (!row.id) throw new Error('identity'); });
  store.upsert({ id: 'old', extra: { x: 1 } });
  assert.throws(() => store.replace([{ id: 'new' }, { id: '' }]), /identity/);
  assert.deepEqual(store.ids(), ['old']);
  let reads = 0;
  const extra = { get value() { reads++; return 1; } };
  assert.throws(() => store.upsert({ id: 'new', extra }), /accessors/);
  assert.equal(reads, 0);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => store.upsert({ id: 'new', extra: cycle }), /circular/);
  assert.deepEqual(store.ids(), ['old']);
});
test('U08/A05: broker factory owns utilities and forwards all price formatter arguments', async () => {
  const { createHostFactory } = await loadModule('src/compat/factory.ts');
  const scope = new DisposalScope(), calls = [];
  const factory = createHostFactory({ createPriceFormatter: (...args) => { calls.push(args); return { format: String }; } }, scope);
  const watched = factory.createWatchedValue(1), delegate = factory.createDelegate();
  watched.subscribe(() => assert.fail('disposed watched callback'));
  delegate.subscribe(null, () => assert.fail('disposed delegate callback'));
  factory.createPriceFormatter(100, 25, false, 0, '0.01 10 0.02');
  assert.deepEqual(calls, [[100, 25, false, 0, '0.01 10 0.02']]);
  scope.destroy(); watched.setValue(2); delegate.fire();
  assert.throws(() => factory.createWatchedValue(1), /closed/);
});

test('A04/X02: immutable DTOs accept ordinary parent-frame records without executing accessors or accepting class instances', async () => {
  const { runInNewContext } = await import('node:vm');
  const { snapshot } = await loadModule('src/core/immutable.ts');
  const source = runInNewContext('({ id: "parent", nested: [{ value: 12 }], empty: Object.create(null) })');
  const copied = snapshot(source);
  assert.deepEqual(copied, { id: 'parent', nested: [{ value: 12 }], empty: {} });
  assert(Object.isFrozen(copied.nested[0]));
  source.nested[0].value = 99; assert.equal(copied.nested[0].value, 12);
  assert.throws(() => snapshot(runInNewContext('new (class Value { constructor() { this.id = "class"; } })()')), /ordinary records/);
  assert.throws(() => snapshot(runInNewContext('({ get value() { throw new Error("getter executed"); } })')), /accessors/);
});


test('A04/A05: deleted identities use a shared revision watermark while live identities retain their own revision', () => {
  const store = new EntityStore(() => {});
  try {
    assert.equal(store.revision('unknown'), 0);
    store.upsert({ id: 'live' }); const liveRevision = store.revision('live');
    for (let index = 0; index < 10000; index++) {
      const id = `closed-${index}`; store.upsert({ id }); const before = store.revision(id); store.remove(id);
      assert(store.revision(id) > before);
    }
    assert.deepEqual(store.ids(), ['live']); assert.equal(store.revision('live'), liveRevision);
    const watermark = store.revision('unknown');
    for (const id of ['closed-0', 'closed-5000', 'closed-9999']) assert.equal(store.revision(id), watermark);
    store.upsert({ id: 'closed-0' }); assert(store.revision('closed-0') > watermark);
    assert.equal(store.revision('closed-5000'), store.revision('closed-0'));
    assert.equal(store.revision('live'), liveRevision);
  } finally { store.destroy(); }
});
test('X09: a pushed entity is deep-copied once at the host boundary and stored without further copies', async () => {
  const { snapshot, EntityStore, SnapshotDataset } = await loadModule('test/support/immutable-pipeline.ts');
  const source = { id: 'A', price: 10, nested: { values: [1, 2] } };
  const copied = snapshot(source);
  assert.notEqual(copied, source); assert(Object.isFrozen(copied.nested.values));
  assert.equal(snapshot(copied), copied, 'a produced snapshot is returned unchanged');
  assert.equal(snapshot({ wrapper: copied }).wrapper, copied, 'nested produced values are reused');
  const store = new EntityStore(() => {});
  const dataset = new SnapshotDataset(store, async () => [], { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} });
  dataset.push(copied);
  assert.equal(store.get('A'), copied, 'the store keeps the host-level copy');
  source.price = 99; assert.equal(store.get('A').price, 10);
  dataset.destroy(); store.destroy();
});
test('X09: symbol metadata caches are bounded', async () => {
  const { SymbolCatalog } = await loadModule('src/core/symbol-catalog.ts');
  const broker = { symbolInfo: async symbol => ({ qty: { min: 1, max: 10, step: 1 }, minTick: 0.01, pipSize: 0.01, pipValue: 1, description: symbol }), getSymbolSpecificTradingOptions: async () => ({ supportReversePosition: true }) };
  const catalog = new SymbolCatalog({ ready: Promise.resolve(broker), fallbackFormatters: {}, alive: () => true, generation: () => 0, broker: () => broker, read: load => Promise.resolve(load()) });
  for (let index = 0; index < 250; index++) await catalog.info(`S${index}`);
  assert.equal(catalog.options('S0'), undefined, 'the least recently used symbol was evicted');
  assert.deepEqual(catalog.options('S249'), { supportReversePosition: true });
  catalog.destroy();
});
test('A04/X09: an in-flight symbol lookup survives eviction pressure and a symbol in use keeps its options', async () => {
  const { SymbolCatalog } = await loadModule('src/core/symbol-catalog.ts');
  const { BoundedMap } = await loadModule('src/core/bounded-map.ts');
  const slow = deferred();
  const instrument = symbol => ({ qty: { min: 1, max: 10, step: 1 }, minTick: 0.01, pipSize: 0.01, pipValue: 1, description: symbol });
  const broker = {
    symbolInfo: symbol => (symbol === 'SLOW' ? slow.promise : Promise.resolve(instrument(symbol))),
    getSymbolSpecificTradingOptions: async symbol => ({ supportReversePosition: symbol === 'ACTIVE' }),
  };
  const catalog = new SymbolCatalog({ ready: Promise.resolve(broker), fallbackFormatters: {}, alive: () => true, generation: () => 0, broker: () => broker, read: load => Promise.resolve(load()) });
  const pending = catalog.info('SLOW');
  await catalog.info('ACTIVE');
  for (let index = 0; index < 250; index++) {
    await catalog.info(`S${index}`);
    // A chart or ticket on ACTIVE reads its policy between other lookups.
    if (index % 50 === 0) catalog.options('ACTIVE');
  }
  slow.resolve(instrument('SLOW'));
  assert.equal((await pending).description, 'SLOW', 'eviction pressure never fails the caller of a running lookup');
  assert.deepEqual(catalog.options('ACTIVE'), { supportReversePosition: true }, 'a symbol read while others load is not the eviction victim');
  assert.equal(catalog.options('S0'), undefined);
  const cache = new BoundedMap(2);
  cache.set('A', 1); cache.set('B', 2); cache.get('A'); cache.set('C', 3);
  assert.equal(cache.get('B'), undefined, 'a read refreshes recency'); assert.equal(cache.get('A'), 1);
  catalog.destroy();
});
test('U06/B04: percentages have one display format', async () => {
  const { formatPercent } = await loadModule('src/core/number-precision.ts');
  assert.equal(formatPercent(62.5), (62.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%');
  assert.equal(formatPercent(undefined), '—'); assert.equal(formatPercent(Number.POSITIVE_INFINITY), '—');
});
test('O02/U09: users see platform wording, bounded broker rejections, and never raw provider errors', async () => {
  const { TradingError, boundMessage, brokerRejectionError, userMessage, MAX_BROKER_MESSAGE } = await loadModule('src/core/errors.ts');
  assert.equal(userMessage(new TradingError('disconnected', 'Reconnect before trading.'), 'x'), 'Reconnect before trading.');
  assert.equal(userMessage({ code: 'rejected', message: '  Insufficient\nmargin\u0007 ' }, 'x'), 'Insufficient margin');
  assert.equal(userMessage(new Error('ECONNRESET at 10.0.0.4:443'), 'Try again.'), 'Try again.');
  assert.equal(userMessage({ code: 'ECONNRESET', message: 'socket' }, 'Try again.'), 'Try again.');
  assert.equal(userMessage({ code: 'rejected', message: ' \n ' }, 'Try again.'), 'Try again.');
  const long = boundMessage('x'.repeat(1000));
  assert.equal(long.length, MAX_BROKER_MESSAGE); assert(long.endsWith('…'));
  assert.equal(brokerRejectionError({ code: 'rejected', message: 'a'.repeat(500) }, 'fallback').message.length, MAX_BROKER_MESSAGE);
  assert.equal(brokerRejectionError({ code: 'invalid', message: 'line one\r\nline two' }, 'fallback').message, 'line one line two');
});
