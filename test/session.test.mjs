import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { createTradingSession } = await loadModule('src/core/session.ts');
const { NotificationType } = await loadModule('src/contracts/broker.ts');
const instrument = { description: 'Example', qty: { min: 1, max: 100, step: 1, default: 2 }, pipValue: 1, pipSize: 0.01, minTick: 0.01 };
const baseOrder = { id: 'O', symbol: 'X', side: 1, type: 1, qty: 2, status: 6, limitPrice: 10 };
function fixture(factory, overrides = {}) {
  const clock = new ManualClock(), settings = new Map();
  let host, broker, factoryCalls = 0;
  const options = {
    clock, settingsKey: 'test', settings: mapSettings(settings),
    formatters: stringFormatters,
    marketData: { acquireQuotes: () => () => {}, acquireDepth: () => () => {} },
    brokerFactory: h => {
      host = h; factoryCalls++;
      broker = { connectionStatus: () => 1, currentAccount: () => 'A', accountsMetainfo: async () => [{ id: 'A', name: 'Account A' }], accountManagerInfo: () => ({ accountTitle: 'Test', summary: [], orderColumns: [], positionColumns: [] }), orders: async () => [baseOrder], positions: async () => [], ordersHistory: async () => [], executions: async () => [], symbolInfo: async () => instrument, isTradable: async () => true, chartContextMenuActions: async () => [], placeOrder: async () => ({}), modifyOrder: async () => {}, cancelOrder: async () => {} };
      factory?.(broker, host); return broker;
    },
  };
  const session = createTradingSession({ ...options, ...overrides });
  return { session, clock, settings, host, broker, factoryCalls };
}
test('A01: one factory, constructor pushes survive snapshots and inputs clone at ingress', async () => {
  const { session, factoryCalls, host, clock } = fixture((broker, host) => {
    const pushed = { ...baseOrder, limitPrice: 12 }; host.orderUpdate(pushed); pushed.limitPrice = 99;
  });
  await session.ready; assert.equal(factoryCalls, 1); assert.equal(session.state.orders.get('O').limitPrice, 12);
  assert.equal(session.state.orders.upsert, undefined); assert.equal(session.policy.set, undefined);
  session.destroy(); host.orderUpdate(baseOrder); assert.equal(session.state.orders.ids().length, 0); assert.equal(clock.timers.size, 0);
});
test('O01/O03: actual command confirms update-before-response; absent update stays unconfirmed with one broker call', async () => {
  let calls = 0;
  const { session, host, broker, clock } = fixture(); await session.ready;
  broker.placeOrder = async order => { calls++; host.orderUpdate({ ...order, id: 'new', status: 6 }); return { orderId: 'new' }; };
  const result = await session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  assert.equal(result.outcome, 'confirmed'); assert.equal(calls, 1);
  broker.placeOrder = async () => { calls++; return {}; };
  const timeout = session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  await flush(); clock.advance(10000); assert.equal((await timeout).outcome, 'unconfirmed'); assert.equal(calls, 2);
  session.destroy(); assert.equal(clock.timers.size, 0);
});
test('O01: update-after-response candidate matching confirms without requiring another push', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  broker.placeOrder = async () => ({});
  const placing = session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  await flush(); host.orderUpdate({ ...baseOrder, id: 'new' });
  assert.equal((await placing).outcome, 'confirmed'); session.destroy();
});
test('O01: a correlated IOC first observed as canceled settles as changed', async () => {
  const { session, host, broker } = fixture(undefined, {
    brokerConfig: { configFlags: {}, durations: [{ name: 'Immediate or cancel', value: 'ioc' }] },
  });
  try {
    await session.ready;
    broker.placeOrder = async order => {
      host.orderUpdate({ ...order, id: 'ioc-order', status: 1, filledQty: 1 });
      return { orderId: 'ioc-order' };
    };
    const result = await session.commands.place({
      context: session.commands.context(),
      order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10, duration: { type: 'ioc' } },
    });
    assert.equal(result.outcome, 'changed');
    assert.deepEqual(result.entityIds, ['ioc-order']);
    assert.equal(session.state.orders.get('ioc-order').filledQty, 1);
  } finally {
    session.destroy();
  }
});
test('A02: disconnect retains rows, disables actions and reconnect refreshes before ready', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  const context = session.commands.context(); broker.connectionStatus = () => 3; host.connectionStatusUpdate(3);
  assert.equal(session.state.orders.get('O').id, 'O'); assert.equal(session.state.connection.get().phase, 'disconnected');
  await assert.rejects(session.commands.cancel({ context, id: 'O' }), error => error.code === 'disconnected');
  const read = deferred(); broker.orders = () => read.promise; broker.connectionStatus = () => 1; host.connectionStatusUpdate(1); await flush();
  assert.equal(session.state.connection.get().phase, 'hydrating'); read.resolve([{ ...baseOrder, limitPrice: 20 }]); await flush();
  assert.equal(session.state.connection.get().phase, 'ready'); assert.equal(session.state.orders.get('O').limitPrice, 20); session.destroy();
});
test('A03: account setter is not confirmation; old reads are fenced and switching pushes discarded', async () => {
  let account = 'A';
  const { session, broker, host } = fixture(broker => { broker.accountsMetainfo = async () => [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]; broker.currentAccount = () => account; broker.setCurrentAccount = () => {}; });
  await session.ready;
  const old = deferred(); broker.orders = () => old.promise; const stale = session.refresh(); await flush();
  const switching = session.commands.selectAccount('B');
  assert.equal(session.state.connection.get().phase, 'switching'); host.orderUpdate({ ...baseOrder, id: 'old-push' });
  assert.equal(session.state.orders.get('old-push'), undefined);
  account = 'B'; broker.orders = async () => [{ ...baseOrder, id: 'B-order' }]; host.currentAccountUpdate(); await switching;
  old.resolve([{ ...baseOrder, id: 'old-read' }]); await assert.rejects(stale); await flush();
  assert.deepEqual(session.state.orders.ids(), ['B-order']); assert.equal(session.state.connection.get().accountId, 'B'); session.destroy();
});
test('A05: destroy during initialization rejects readiness and fences later broker reads', async () => {
  const initial = deferred(); const { session, host, clock } = fixture(broker => { broker.orders = () => initial.promise; });
  await flush(); session.destroy(); await assert.rejects(session.ready, error => error.code === 'disposed');
  initial.resolve([baseOrder]); host.plUpdate('P', 2); await flush(); assert.equal(session.state.orders.ids().length, 0); assert.equal(clock.timers.size, 0);
});
test('U05: custom order dialog owns its submission; custom cancel approval invokes handler exactly once', async () => {
  const { createHostDialogs } = await loadModule('src/compat/host-dialogs.ts');
  const { DialogCoordinator } = await loadModule('src/core/dialog-coordinator.ts');
  let submissions = 0;
  const dialogs = new DialogCoordinator();
  const ui = createHostDialogs(dialogs, { showOrderDialog: async () => { submissions++; return true; }, showCancelOrderDialog: async () => true }, () => baseOrder, () => undefined);
  assert.equal(await ui.showOrderDialog(baseOrder), true); assert.equal(submissions, 1);
  await ui.showCancelOrderDialog('O', async () => { submissions++; }); assert.equal(submissions, 2);
  const confirmation = ui.showConfirmDialog('Confirm', 'Details'); const id = dialogs.current.get().id;
  dialogs.respond(id, true); dialogs.respond(id, true); assert.equal(await confirmation, true); assert.equal(dialogs.current.get(), undefined); dialogs.destroy();
});
test('A05/A01: failed initial hydration rejects ready but keeps the session retryable; destroy releases it', async () => {
  let fail = true;
  const { session, host, clock } = fixture(broker => { broker.orders = async () => { if (fail) throw new Error('read failed'); return [baseOrder]; }; });
  await assert.rejects(session.ready, /read failed/); await flush();
  assert.equal(session.state.connection.get().phase, 'error');
  assert.equal(clock.timers.size, 0);
  fail = false;
  await session.refresh();
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.deepEqual(session.state.orders.ids(), ['O']);
  session.destroy();
  host.orderUpdate({ ...baseOrder, id: 'late' }); assert.equal(session.state.orders.ids().length, 0); assert.equal(clock.timers.size, 0);
  await assert.rejects(session.refresh(), error => error.code === 'disposed');
});
test('A02/A05: pushes buffered during a hydration that fails do not replay on the retry', async () => {
  const metadata = deferred();
  const { session, host, broker } = fixture(broker => { broker.accountsMetainfo = () => metadata.promise; });
  await flush();
  host.equityUpdate(500); host.orderUpdate({ ...baseOrder, limitPrice: 50 });
  metadata.reject(new Error('metadata failed'));
  await assert.rejects(session.ready, /metadata failed/); await flush();
  assert.equal(session.state.connection.get().phase, 'error');
  broker.accountsMetainfo = async () => [{ id: 'A', name: 'Account A' }];
  broker.orders = async () => [{ ...baseOrder, limitPrice: 20 }];
  await session.refresh();
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.equal(session.state.equity.get(), undefined);
  assert.equal(session.state.orders.get('O').limitPrice, 20);
  session.destroy();
});
test('A05: session deadlines are configurable', async () => {
  const { session, broker, clock } = fixture(undefined, { deadlines: { command: 2000, read: 3000 } }); await session.ready;
  broker.placeOrder = async () => ({});
  const placing = session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 33 } });
  await flush(); clock.advance(2000);
  assert.equal((await placing).outcome, 'unconfirmed');
  await flush();
  broker.isTradable = () => new Promise(() => {});
  const stalled = session.isTradable('X'); await flush(); clock.advance(2999); await flush();
  clock.advance(1);
  await assert.rejects(stalled, /too long/);
  session.destroy();
});
test('O03/O04: late unique uncorrelated update reconciles an unconfirmed history record without resending', async () => {
  const { session, host, broker, clock } = fixture(); await session.ready;
  let calls = 0; broker.placeOrder = async () => { calls++; return {}; };
  const operation = session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  await flush(); clock.advance(10000); const result = await operation; assert.equal(result.outcome, 'unconfirmed');
  await flush(); host.orderUpdate({ ...baseOrder, id: 'late' }); await flush();
  assert.equal(session.pending.get(result.commandId).stage, 'confirmed'); assert.equal(calls, 1); session.destroy();
});

test('X01: always-require-confirmation overrides saved and programmatic one-click settings', async () => {
  const f = fixture(undefined, { enabledFeatures: ['always_require_order_confirmation'] });
  await f.session.ready;
  assert.equal(f.session.features.always_require_order_confirmation, true);
  const silent = f.host.silentOrdersPlacement();
  silent.setValue(true);
  assert.equal(silent.value(), false);
  f.session.destroy();
});

test('U05: aborting an owned dialog removes only its queued entry and never approves it', async () => {
  const { DialogCoordinator } = await loadModule('src/core/dialog-coordinator.ts');
  const dialogs = new DialogCoordinator(), first = new AbortController(), second = new AbortController();
  const a = dialogs.request({ kind: 'confirm', title: 'A', content: 'A' }, first.signal);
  const b = dialogs.request({ kind: 'confirm', title: 'B', content: 'B' }, second.signal);
  const c = dialogs.request({ kind: 'confirm', title: 'C', content: 'C' });
  second.abort();
  assert.equal(await b, false);
  assert.equal(dialogs.current.get().request.title, 'A');
  first.abort();
  assert.equal(await a, false);
  assert.equal(dialogs.current.get().request.title, 'C');
  dialogs.respond(dialogs.current.get().id, true);
  assert.equal(await c, true);
  assert.equal(await dialogs.request({ kind: 'properties' }, first.signal), false);
  assert.equal(dialogs.current.get(), undefined);
  dialogs.destroy();
});

test('U09: UI preferences use the session namespace, remain separate from host settings and reject disposed writes', async () => {
  const shared = new Map(), settings = mapSettings(shared);
  const a = fixture(undefined, { settings, settingsKey: 'A' }), b = fixture(undefined, { settings, settingsKey: 'B' });
  let reopened;
  try {
    await Promise.all([a.session.ready,b.session.ready]);
    a.session.preferences.set('table:orders:columns', '{"version":1,"columns":[["qty",false]]}');
    assert.equal(b.session.preferences.get('table:orders:columns'), undefined);
    assert([...shared.keys()].some(key => key.startsWith('lumen.trading.v1.A.ui.')));
    a.host.setQty('X', 5);
    a.session.preferences.set('qty.X', 'not a quantity');
    assert.equal(await a.host.getQty('X'), 5);
    reopened = fixture(undefined, { settings, settingsKey: 'A' });
    await reopened.session.ready;
    assert.equal(reopened.session.preferences.get('table:orders:columns'), a.session.preferences.get('table:orders:columns'));
    a.session.destroy();
    assert.throws(() => a.session.preferences.set('table:orders:columns',''), error => error.code === 'disposed');
  } finally { a.session.destroy(); b.session.destroy(); reopened?.session.destroy(); }
});

test('O03/A05: stalled tradability and preview reads time out without dispatching an order', async () => {
  const { session, broker, clock } = fixture(); await session.ready;
  let calls = 0;
  broker.placeOrder = async () => { calls++; return {}; };
  const request = { context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } };
  const tradability = deferred(); broker.isTradable = () => tradability.promise;
  const placing = assert.rejects(session.commands.place(request), { code: 'broker-unavailable' });
  await flush(); clock.advance(15000); await placing;
  tradability.resolve(true); await flush(); assert.equal(calls, 0);
  broker.isTradable = async () => true;
  const preview = deferred(); let previewCalls = 0; broker.previewOrder = () => { previewCalls++; return preview.promise; };
  const reviewing = assert.rejects(session.commands.preview(request), { code: 'broker-unavailable' });
  for (let i = 0; i < 10 && !previewCalls; i++) await flush();
  assert.equal(previewCalls, 1); clock.advance(15000); await reviewing;
  preview.resolve({ sections: [], confirmId: 'late' }); await flush(); assert.equal(calls, 0);
  session.destroy(); assert.equal(clock.timers.size, 0);
});

test('O03/A03: account changes cancel a pending review immediately, including a provider that never settles', async () => {
  let account = 'A';
  const { session, broker, host, clock } = fixture(broker => {
    broker.accountsMetainfo = async () => [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }];
    broker.currentAccount = () => account; broker.setCurrentAccount = () => {};
  });
  await session.ready;
  const pending = deferred(); broker.isTradable = () => pending.promise;
  const review = assert.rejects(session.commands.validate({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } }), { code: 'stale-context' });
  await flush();
  const switching = session.commands.selectAccount('B');
  await review;
  assert.equal(clock.now(), 0);
  account = 'B'; host.currentAccountUpdate(); await switching;
  pending.resolve(true); await flush(); session.destroy(); assert.equal(clock.timers.size, 0);
});

test('O03: malformed tradability data rejects before dispatch without invoking broker accessors', async () => {
  const { session, broker } = fixture(); await session.ready;
  let calls = 0, getters = 0;
  broker.placeOrder = async () => { calls++; return {}; };
  const request = { context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } };
  for (const result of [null, undefined, 'yes', {}, { tradable: 1 }]) {
    broker.isTradable = async () => result;
    await assert.rejects(session.commands.validate(request), { code: 'configuration' });
    await assert.rejects(session.commands.place(request), { code: 'configuration' });
  }
  broker.isTradable = async () => ({ get tradable() { getters++; return true; } });
  await assert.rejects(session.commands.place(request), { code: 'invalid-input' });
  assert.equal(getters, 0); assert.equal(calls, 0);
  broker.isTradable = async () => ({ tradable: false, reason: 'Closed' });
  await assert.rejects(session.commands.validate(request), { code: 'unsupported' });
  broker.isTradable = async () => ({ tradable: true });
  await session.commands.validate(request); session.destroy();
});

function accountFixture(setter = () => {}) {
  let account = 'A';
  const f = fixture(broker => {
    broker.accountsMetainfo = async () => ['A', 'B', 'C'].map(id => ({ id, name: id }));
    broker.currentAccount = () => account;
    broker.setCurrentAccount = setter;
  });
  return { ...f, notify(id) { account = id; f.host.currentAccountUpdate(); } };
}

test('A03: account selection remains pending through hydration and duplicate notifications supersede old reads', async () => {
  let setters = 0;
  const f = accountFixture(() => { setters++; }); await f.session.ready;
  const first = deferred(), second = deferred(); let reads = 0, settled = false;
  f.broker.orders = () => (++reads === 1 ? first.promise : second.promise);
  const selection = f.session.commands.selectAccount('B').then(() => { settled = true; });
  f.notify('B'); await flush();
  assert.equal(f.session.state.connection.get().phase, 'hydrating');
  await assert.rejects(f.session.commands.selectAccount('C'), { code: 'operation-pending' });
  f.clock.advance(10000); await flush(); assert.equal(settled, false);
  f.notify('B'); await flush(); assert.equal(reads, 2);
  first.resolve([{ ...baseOrder, id: 'obsolete' }]); await flush(); assert.equal(settled, false);
  second.resolve([{ ...baseOrder, id: 'B-order' }]); await selection;
  assert.equal(f.session.state.connection.get().accountId, 'B');
  assert.deepEqual(f.session.state.orders.ids(), ['B-order']); assert.equal(setters, 1);
  f.session.destroy(); assert.equal(f.clock.timers.size, 0);
});

test('A03: wrong-account notification rejects selection while reconciling the actual broker account', async () => {
  const f = accountFixture(); await f.session.ready;
  const selection = assert.rejects(f.session.commands.selectAccount('B'), { code: 'stale-context' });
  f.notify('C'); await selection; await flush(); await flush();
  assert.equal(f.session.state.connection.get().accountId, 'C');
  assert.equal(f.session.state.connection.get().phase, 'ready'); f.session.destroy();
});

test('A03/A05: missing notification and hung hydration have separate deadlines and never fabricate confirmation', async () => {
  const f = accountFixture(); await f.session.ready;
  const unconfirmed = assert.rejects(f.session.commands.selectAccount('B'), { code: 'broker-unavailable' });
  f.clock.advance(10000); await unconfirmed;
  assert.equal(f.session.state.connection.get().phase, 'error');
  const hung = deferred(); f.broker.orders = () => hung.promise;
  const hydrating = assert.rejects(f.session.commands.selectAccount('B'), { code: 'broker-unavailable' });
  f.notify('B'); await flush(); f.clock.advance(15000); await hydrating;
  assert.equal(f.session.state.connection.get().phase, 'error');
  hung.resolve([{ ...baseOrder, id: 'late' }]); await flush();
  assert.equal(f.session.state.orders.get('late'), undefined);
  f.session.destroy(); assert.equal(f.clock.timers.size, 0);
});

test('A03/A05: sync and runtime async setter errors, disconnect and disposal reject pending selection once', async () => {
  for (const setter of [() => { throw new Error('setter failed'); }, () => Promise.reject(new Error('setter failed'))]) {
    const f = accountFixture(setter); await f.session.ready;
    const errors = []; f.session.state.connection.subscribe(value => { if (value.phase === 'error') errors.push(value.error); });
    await assert.rejects(f.session.commands.selectAccount('B'), /setter failed/);
    assert.deepEqual(errors, ['The account could not be changed.'], 'the failure is published in platform wording, not raw adapter text');
    await flush(); await flush();
    assert.equal(f.session.state.connection.get().phase, 'ready', 'the still-selected account is read again');
    assert.equal(f.session.state.connection.get().accountId, 'A');
    assert(f.session.state.orders.ids().length > 0, 'its tables return');
    f.session.destroy(); assert.equal(f.clock.timers.size, 0);
  }
  const f = accountFixture(); await f.session.ready;
  const interrupted = assert.rejects(f.session.commands.selectAccount('B'), { code: 'disconnected' });
  f.broker.connectionStatus = () => 3; f.host.connectionStatusUpdate(3); await interrupted;
  f.broker.connectionStatus = () => 1; f.host.connectionStatusUpdate(1); await flush(); await flush();
  const hung = deferred(); f.broker.orders = () => hung.promise;
  const disposed = assert.rejects(f.session.commands.selectAccount('B'), { code: 'disposed' });
  f.notify('B'); await flush(); f.session.destroy(); await disposed;
  hung.reject(new Error('late')); await flush(); assert.equal(f.clock.timers.size, 0);
});

test('U08/A05: host formatter reads have deadlines and never invoke providers after disposal', async () => {
  let calls = 0;
  const hung = deferred();
  const f = fixture(undefined, { formatters: {
    defaultPrice: () => { calls++; return hung.promise; },
    numeric: () => { calls++; return hung.promise; },
    quantity: () => { calls++; return hung.promise; },
    createPriceFormatter: () => ({ format: String }),
  } });
  await f.session.ready;
  const pending = [f.host.defaultFormatter('X', true), f.host.numericFormatter(2), f.host.quantityFormatter(0)]
    .map(read => assert.rejects(read, { code: 'broker-unavailable' }));
  f.clock.advance(15000); await Promise.all(pending); assert.equal(calls, 3);
  const closing = assert.rejects(f.host.numericFormatter(2), { code: 'disposed' });
  f.session.destroy(); await closing;
  for (const read of [() => f.host.defaultFormatter('X', true), () => f.host.numericFormatter(2), () => f.host.quantityFormatter(0)])
    await assert.rejects(read(), { code: 'disposed' });
  assert.equal(calls, 4); assert.equal(f.clock.timers.size, 0);
  hung.resolve({ format: String }); await flush();
});

test('U08: constructor host formatter reads preserve arguments and are available before the broker returns', async () => {
  let request;
  const calls = [];
  const formatter = { format: String };
  const f = fixture((_broker, host) => {
    request = Promise.all([host.defaultFormatter('X', false), host.numericFormatter(4), host.quantityFormatter(3)]);
  }, { formatters: {
    defaultPrice: async (...args) => { calls.push(['price', ...args]); return formatter; },
    numeric: async (...args) => { calls.push(['numeric', ...args]); return formatter; },
    quantity: async (...args) => { calls.push(['quantity', ...args]); return formatter; },
    createPriceFormatter: () => formatter,
  } });
  await f.session.ready; assert.deepEqual(await request, [formatter, formatter, formatter]);
  assert.deepEqual(calls, [['price', 'X', false], ['numeric', 4], ['quantity', 3]]);
  f.session.destroy(); assert.equal(f.clock.timers.size, 0);
});

test('D01/A03: host quotes beat late initial snapshots and cached replays while later live updates remain authoritative', async () => {
  const { createTradingMarketData } = await loadModule('src/market-data/subscriptions.ts');
  const initial = [], streams = [];
  const port = createTradingMarketData({
    getQuotes(_symbols, callback, error) { initial.push({ callback, error }); },
    subscribeQuotes(_normal, _fast, callback) { streams.push(callback); }, unsubscribeQuotes() {},
  }, () => .01);
  const f = fixture(undefined, { marketData: port }); await f.session.ready;
  const first = [], second = [];
  const release = f.session.acquireQuotes('X', 'fast', value => first.push(value)); await flush();
  const row = price => [{ n: 'X', s: 'ok', v: { lp: price, bid: price - 1, ask: price + 1 } }];
  streams[0](row(20)); assert.equal(first.at(-1).value.trade, 20);
  f.host.realtimeUpdate('X', { trade: 30, bid: 29, ask: 31 });
  initial[0].callback(row(10)); assert.equal(first.at(-1).value.trade, 30);
  const release2 = f.session.acquireQuotes('X', 'normal', value => second.push(value));
  assert.equal(second.at(-1).value.trade, 30); assert.equal(f.session.state.quotes.get('X').trade, 30);
  release(); await flush(); initial[1].error(); assert.equal(second.at(-1).value.trade, 30);
  streams[0](row(99)); assert.equal(second.at(-1).value.trade, 30);
  streams[1](row(40)); assert.equal(second.at(-1).value.trade, 40); assert.equal(f.session.state.quotes.get('X').trade, 40);
  release2(); f.session.destroy(); port.destroy(); assert.equal(f.clock.timers.size, 0);
});

test('D01/A03: host snapshot preference is account-scoped and cannot suppress the new account initial quote', async () => {
  const { createTradingMarketData } = await loadModule('src/market-data/subscriptions.ts');
  let account = 'A'; const initial = [];
  const port = createTradingMarketData({ getQuotes(_symbols, callback) { initial.push(callback); }, subscribeQuotes() {}, unsubscribeQuotes() {} }, () => .01);
  const f = fixture(broker => {
    broker.accountsMetainfo = async () => ['A', 'B'].map(id => ({ id, name: id }));
    broker.currentAccount = () => account; broker.setCurrentAccount = () => {};
  }, { marketData: port }); await f.session.ready;
  const events = []; const release = f.session.acquireQuotes('X', 'fast', value => events.push(value)); await flush();
  f.host.realtimeUpdate('X', { trade: 30 });
  const switching = f.session.commands.selectAccount('B'); account = 'B'; f.host.currentAccountUpdate(); await switching; await flush();
  initial[0]([{ n: 'X', s: 'ok', v: { lp: 99 } }]); assert.equal(f.session.state.quotes.get('X'), undefined);
  initial[1]([{ n: 'X', s: 'ok', v: { lp: 10 } }]);
  assert.equal(events.at(-1).value.trade, 10); assert.equal(f.session.state.quotes.get('X').trade, 10);
  release(); f.session.destroy(); port.destroy();
});

test('U05: host ticket preferences publish immutable changes, validate inputs and preserve required confirmation', async () => {
  const f = fixture(undefined, { requireConfirmation: true }); await f.session.ready;
  const seen = []; const release = f.session.ticketSettings.subscribe(value => seen.push(value));
  assert.equal(f.session.ticketSettings.set, undefined);
  await f.host.setOrderTicketSetting('showRelativePriceControl', true);
  assert.equal(f.session.ticketSettings.get().showRelativePriceControl, true);
  assert.equal(f.settings.get('lumen.trading.v1.test.showRelativePriceControl'), 'true');
  assert(Object.isFrozen(seen[0]));
  for (const name of ['unknown', '__proto__', 'toString']) {
    await assert.rejects(f.host.getOrderTicketSetting(name), { code: 'invalid-input' });
    await assert.rejects(f.host.setOrderTicketSetting(name, true), { code: 'invalid-input' });
  }
  await assert.rejects(f.host.setOrderTicketSetting('showRelativePriceControl', 'false'), { code: 'invalid-input' });
  await assert.rejects(f.host.setOrderTicketSetting('showOrderPreview', false), { code: 'unsupported' });
  assert.equal(await f.host.getOrderTicketSetting('showOrderPreview'), true);
  assert.equal(seen.length, 1);
  release(); f.session.destroy();
  await assert.rejects(f.host.setOrderTicketSetting('showRelativePriceControl', false), { code: 'disposed' });
});

test('U05: constructor ticket settings reach the session reader and failed persistence keeps the live display choice', async () => {
  const settings = { get: () => undefined, set() { throw new Error('Storage unavailable'); }, remove() {} };
  const f = fixture((_broker, host) => { void host.setOrderTicketSetting('showRelativePriceControl', true).catch(() => {}); }, { settings });
  await f.session.ready;
  assert.equal(f.session.ticketSettings.get().showRelativePriceControl, true);
  await assert.rejects(f.host.setOrderTicketSetting('showRelativePriceControl', false), /Storage unavailable/);
  assert.equal(f.session.ticketSettings.get().showRelativePriceControl, false);
  let reads = 0;
  await assert.rejects(f.host.getOrderTicketSetting({ toString() { reads++; return 'showOrderPreview'; } }), { code: 'invalid-input' });
  assert.equal(reads, 0); f.session.destroy();
});

test('U04/U05: enabling preview during command preparation fences a previously permitted direct placement', async () => {
  const tradable = deferred();
  const f = fixture(broker => { broker.isTradable = () => tradable.promise; broker.previewOrder = async () => ({ sections: [] }); }, { brokerConfig: { configFlags: { supportPlaceOrderPreview: true } } });
  await f.session.ready;
  try {
    await f.host.setOrderTicketSetting('showOrderPreview', false);
    let calls = 0; f.broker.placeOrder = async () => { calls++; return {}; };
    const place = f.session.commands.place({ context: f.session.commands.context(), order: { symbol: 'X', side: 1, type: 1, qty: 2, limitPrice: 10 } });
    await flush(); await f.host.setOrderTicketSetting('showOrderPreview', true); tradable.resolve(true);
    await assert.rejects(place, /Review the current order/); assert.equal(calls, 0);
  } finally { f.session.destroy(); }
});

test('U04/U05: preview preference is checked again immediately before dispatch after protected-order reads', async () => {
  const options = deferred(); let optionReads = 0;
  const f = fixture(broker => {
    broker.previewOrder = async () => ({ sections: [] });
    broker.getOrderDialogOptions = () => { optionReads++; return options.promise; };
  }, { brokerConfig: { configFlags: { supportPlaceOrderPreview: true, supportOrderBrackets: true } } });
  await f.session.ready;
  try {
    await f.host.setOrderTicketSetting('showOrderPreview', false);
    let calls = 0; f.broker.placeOrder = async () => { calls++; return {}; };
    const place = f.session.commands.place({ context: f.session.commands.context(), order: { symbol: 'X', side: 1, type: 1, qty: 2, limitPrice: 10, takeProfit: 12 } });
    await flush(); assert.equal(optionReads, 1);
    await f.host.setOrderTicketSetting('showOrderPreview', true); options.resolve(undefined);
    await assert.rejects(place, /Review the current order/); assert.equal(calls, 0);
  } finally { f.session.destroy(); }
});


test('A02/X01: tradability reads normalize both broker forms and settle on session destruction', async () => {
  const f = fixture();
  try {
    await f.session.ready;
    // Answers are cached per symbol and account generation, so each broker form uses its own symbol.
    for (const [index, value] of [true, false, { tradable: true }, { tradable: false, reason: 'Closed' }].entries()) {
      f.broker.isTradable = async () => value;
      assert.equal(await f.session.isTradable(`S${index}`), value === true || value.tradable === true);
    }
    f.broker.isTradable = async () => { throw new Error('a cached answer must not reach the broker'); };
    assert.equal(await f.session.isTradable('S1'), false, 'a repeat read uses the cached answer');
    const loading = deferred(); f.broker.isTradable = () => loading.promise;
    const request = f.session.isTradable('X'); await flush(); f.session.destroy();
    await assert.rejects(request, error => error.code === 'disposed');
    loading.resolve(true); await flush(); assert.equal(f.clock.timers.size, 0);
  } finally { f.session.destroy(); }
});


test('A05/O01: failing read-only consumers cannot turn an authoritative broker push into an unconfirmed command', async () => {
  const f = fixture();
  try {
    await f.session.ready; const seen = [];
    f.session.state.orders.subscribeChanges(() => { throw Error('consumer render failed'); });
    f.session.state.orders.subscribeChanges(change => seen.push(...change.added));
    f.broker.placeOrder = async order => { f.host.orderUpdate({ ...order, id: 'confirmed-with-failing-consumer', status: 6 }); return { orderId: 'confirmed-with-failing-consumer' }; };
    const result = await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
    assert.equal(result.outcome, 'confirmed'); assert.deepEqual(seen, ['confirmed-with-failing-consumer']);
    assert.equal(f.session.state.connection.get().phase, 'ready');
    f.session.state.connection.subscribe(() => { throw Error('consumer connection listener failed'); });
    f.broker.connectionStatus = () => 3; assert.doesNotThrow(() => f.host.connectionStatusUpdate(3)); assert.equal(f.session.state.connection.get().phase, 'disconnected');
  } finally { f.session.destroy(); }
});


test('A04/X01: disabled execution history makes no reads and enabling it shares one current symbol request', async () => {
  let reads = 0;
  const f = fixture(broker => { broker.executions = async symbol => { reads++; return [{ id: 'current-fill', symbol, side: 1, qty: 1, price: 10, time: 1700000000000 }]; }; }, { brokerConfig: { configFlags: { supportExecutions: false } } });
  let first, second;
  try {
    first = f.session.acquireExecutions('X'); await f.session.ready; await flush();
    second = f.session.acquireExecutions('X'); await flush();
    assert.equal(reads, 0); assert.deepEqual(f.session.state.executions.ids(), []);
    f.host.patchConfig({ supportExecutions: true }); await flush();
    assert.equal(reads, 1); assert.equal(f.session.state.executions.get('current-fill').symbol, 'X');
    f.host.patchConfig({ supportExecutions: true }); await flush(); assert.equal(reads, 1);
    f.host.patchConfig({ supportExecutions: false }); await flush(); assert.equal(reads, 1);
    first(); second(); f.host.patchConfig({ supportExecutions: true }); await flush(); assert.equal(reads, 1);
  } finally { first?.(); second?.(); f.session.destroy(); }
});

test('A04/A05: disabling execution history fences late reads and reenable refreshes surviving demand', async () => {
  const requests = [];
  const f = fixture(broker => { broker.executions = () => { const pending = deferred(); requests.push(pending); return pending.promise; }; });
  let release;
  try {
    await f.session.ready; release = f.session.acquireExecutions('X'); await flush(); assert.equal(requests.length, 1);
    f.host.patchConfig({ supportExecutions: false });
    requests[0].resolve([{ id: 'disabled-late', symbol: 'X', side: 1, qty: 1, price: 10, time: 1700000000000 }]); await flush();
    assert.equal(f.session.state.executions.get('disabled-late'), undefined);
    f.host.patchConfig({ supportExecutions: true }); await flush(); assert.equal(requests.length, 2);
    requests[1].resolve([{ id: 'enabled-current', symbol: 'X', side: 1, qty: 1, price: 11, time: 1700000000000 }]); await flush();
    assert.equal(f.session.state.executions.get('enabled-current').price, 11);
    assert.equal(f.session.notifications.get().length, 0, 'capability cancellation is not a broker failure notification');
  } finally { release?.(); f.session.destroy(); }
});
test('A05: execution snapshots use the configured deadline and report an error notification', async () => {
  const f = fixture(broker => { broker.executions = () => new Promise(() => {}); }, { deadlines: { snapshot: 1234 } });
  let release;
  try {
    await f.session.ready; release = f.session.acquireExecutions('X'); await flush();
    f.clock.advance(1233); await flush(); assert.equal(f.session.notifications.get().length, 0);
    f.clock.advance(1); await flush();
    const notification = f.session.notifications.get().at(-1);
    assert.equal(notification?.title, 'Executions unavailable');
    assert.equal(notification?.type, NotificationType.Error);
  } finally { release?.(); f.session.destroy(); }
});


test('A04/B06: a removed and reused position identity still rejects its earlier captured command context', async () => {
  const f = fixture();
  try {
    await f.session.ready;
    const position = { id: 'reused-position', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
    f.host.positionUpdate(position); const context = f.session.commands.context(position.id, 'position');
    f.host.positionUpdate({ ...position, qty: 0 }); assert(f.session.state.positions.revision(position.id) > context.revision);
    f.host.positionUpdate(position); assert(f.session.state.positions.revision(position.id) > context.revision);
    await assert.rejects(f.session.commands.close({ id: position.id, context }), error => error.code === 'stale-context');
    assert.equal(f.session.state.positions.get(position.id).qty, 2);
  } finally { f.session.destroy(); }
});


test('B03/U05: paired-bracket capability changes confirmation wording without dispatching sibling cancellations', async () => {
  for (const paired of [false, true]) {
    const f = fixture(undefined, { brokerConfig: { configFlags: { supportCancellingBothBracketsOnly: paired } } });
    try {
      await f.session.ready;
      const child = { ...baseOrder, id: 'take-profit', side: -1, limitPrice: 12, parentId: 'O', parentType: 1 };
      f.host.orderUpdate(child);
      const calls = []; f.broker.cancelOrder = async id => { calls.push(id); f.host.orderUpdate({ ...child, status: 1 }); };
      const context = f.session.commands.context(child.id);
      const cancellation = f.host.showCancelOrderDialog(child.id, async () => { await f.session.commands.cancel({ id: child.id, context }); });
      const entry = f.session.dialogs.current.get();
      assert.equal(entry.request.title, 'Cancel protection');
      const described = [child.symbol, `Sell Limit ${child.qty} @ 12`];
      assert.deepEqual(entry.request.content, paired ? [...described, 'Its paired order will also be canceled.'] : described);
      assert.equal(entry.request.mainButtonText, 'Cancel protection'); assert.equal(entry.request.cancelButtonText, 'Keep protection');
      assert.deepEqual(calls, []); f.session.dialogs.respond(entry.id, true); await cancellation;
      assert.deepEqual(calls, ['take-profit']);
      const ordinary = f.host.showCancelOrderDialog('O', async () => {}), plain = f.session.dialogs.current.get();
      assert.equal(plain.request.title, 'Cancel order'); assert.deepEqual(plain.request.content, ['X', 'Buy Limit 2 @ 10']); f.session.dialogs.respond(plain.id, false); await ordinary;
    } finally { f.session.destroy(); }
  }
});

test('B03/U05: changed paired-cancellation semantics require a fresh review and never invoke the handler', async () => {
  const f = fixture(); let dispatched = 0;
  try {
    await f.session.ready; f.host.orderUpdate({ ...baseOrder, id: 'child', parentId: 'O', parentType: 1 });
    const cancellation = f.host.showCancelBracketsDialog('child', async () => { dispatched++; });
    const entry = f.session.dialogs.current.get(); f.host.patchConfig({ supportCancellingBothBracketsOnly: true }); f.session.dialogs.respond(entry.id, true);
    await assert.rejects(cancellation, error => error.code === 'stale-context'); assert.equal(dispatched, 0);
  } finally { f.session.destroy(); }
});


test('B03/U05: all bracket cancellation host methods preserve custom approval ownership and copied entity inputs', async () => {
  const { createHostDialogs } = await loadModule('src/compat/host-dialogs.ts');
  const { DialogCoordinator } = await loadModule('src/core/dialog-coordinator.ts');
  const dialogs = new DialogCoordinator(), child = { ...baseOrder, id: 'child', parentId: 'O', parentType: 1 }; let customCalls = 0, handlers = 0;
  try {
    const ui = createHostDialogs(dialogs, { showCancelOrderDialog: async entity => { customCalls++; assert.equal(entity.id, 'child'); entity.qty = 999; return true; } }, () => child, () => undefined, () => 1, () => true);
    for (const method of ['showCancelOrderDialog', 'showCancelBracketsDialog', 'showCancelMultipleBracketsDialog']) {
      await ui[method]('child', async () => { handlers++; });
      assert.equal(dialogs.current.get(), undefined); assert.equal(child.qty, 2);
    }
    assert.equal(customCalls, 3); assert.equal(handlers, 3);
  } finally { dialogs.destroy(); }
});
test('X01: host default context actions use the trade context to offer limit or stop orders at the chart price', async () => {
  const f = fixture();
  try {
    await f.session.ready;
    const actions = await f.host.defaultContextMenuActions({ symbol: 'X', displaySymbol: 'X', value: 9.5, formattedValue: '9.50', last: 10 });
    assert.deepEqual(actions.slice(0, 2).map((action) => action.text), ['Buy X @ 9.50 Limit', 'Sell X @ 9.50 Stop']);
    const market = await f.host.defaultContextMenuActions({ symbol: 'X', displaySymbol: 'X', value: null, formattedValue: '', last: 10 });
    assert.deepEqual(market.slice(0, 2).map((action) => action.text), ['Buy', 'Sell']);
  } finally { f.session.destroy(); }
});
test('A02: pushes while disconnected are discarded and the reconnect snapshot is authoritative', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  broker.connectionStatus = () => 3; host.connectionStatusUpdate(3);
  host.realtimeUpdate('X', { ask: 1, bid: 1 }); host.realtimeUpdate('X', { ask: 2, bid: 2 }); host.realtimeUpdate('X', { ask: 3, bid: 3 });
  host.equityUpdate(500); host.orderUpdate({ ...baseOrder, limitPrice: 50 });
  const read = deferred(); broker.orders = () => read.promise; broker.connectionStatus = () => 1; host.connectionStatusUpdate(1); await flush();
  read.resolve([{ ...baseOrder, limitPrice: 20 }]); await flush();
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.equal(session.state.equity.get(), undefined); assert.equal(session.state.quotes.get('X'), undefined);
  assert.equal(session.state.orders.get('O').limitPrice, 20);
  host.equityUpdate(600); host.realtimeUpdate('X', { ask: 4, bid: 4 });
  assert.equal(session.state.equity.get(), 600);
  session.destroy();
});
test('A02: the pre-identity push buffer is bounded and keeps the newest pushes', async () => {
  const { EARLY_PUSH_LIMIT } = await loadModule('src/core/account-lifecycle.ts');
  const { session } = fixture((broker, host) => {
    for (let index = 0; index < EARLY_PUSH_LIMIT + 5; index++) host.orderUpdate({ ...baseOrder, id: `E${index}` });
  });
  await session.ready;
  assert.equal(session.state.orders.get('E0'), undefined); assert.ok(session.state.orders.get(`E${EARLY_PUSH_LIMIT + 4}`));
  session.destroy();
});
test('O05: modifying an order on an untradable symbol rejects with the broker reason before any broker call', async () => {
  let modifications = 0;
  const { session, broker } = fixture(); await session.ready;
  broker.modifyOrder = async () => { modifications++; };
  broker.isTradable = async () => ({ tradable: false, reason: 'The market is closed.' });
  await assert.rejects(
    session.commands.modify({ context: session.commands.context('O', 'order'), order: { ...baseOrder, limitPrice: 11 } }),
    error => error.message.includes('The market is closed.'),
  );
  assert.equal(modifications, 0); session.destroy();
});
test('C01/A04: snapshot reads drop quantity-zero positions, and a refresh with one removes the open position', async () => {
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
  let rows = [position, { ...position, id: 'flat', qty: 0 }];
  const { session } = fixture(broker => { broker.positions = async () => rows; }, { brokerConfig: { configFlags: { supportPositions: true } } });
  await session.ready;
  assert.deepEqual(session.state.positions.ids(), ['P']);
  rows = [{ ...position, qty: 0 }];
  await session.refresh();
  assert.deepEqual(session.state.positions.ids(), []);
  session.destroy();
});
test('O01: a broker echoing a tick-rounded price and normalised quantity still confirms an uncorrelated placement', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  broker.placeOrder = async order => { host.orderUpdate({ ...order, id: 'rounded', status: 6, limitPrice: 10.000000000000002, qty: 2.0000000001 }); return {}; };
  const result = await session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  assert.equal(result.outcome, 'confirmed'); session.destroy();
});
test('O01: a returned order ID confirms even when the broker drops custom fields from its echo', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  broker.placeOrder = async order => { const { customFields, ...echo } = order; host.orderUpdate({ ...echo, id: 'stripped', status: 6, limitPrice: 10.004 }); return { orderId: 'stripped' }; };
  const result = await session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10, customFields: { note: 'a' } } });
  assert.equal(result.outcome, 'confirmed'); assert.deepEqual(result.entityIds, ['stripped']); session.destroy();
});
test('O02/O04: two uncorrelated candidates that both match within a tick stay unconfirmed; one beyond it does not count', async () => {
  const { session, host, broker, clock } = fixture(); await session.ready;
  broker.placeOrder = async order => {
    host.orderUpdate({ ...order, id: 'near-a', status: 6, limitPrice: 10.001 });
    host.orderUpdate({ ...order, id: 'near-b', status: 6, limitPrice: 9.999 });
    return {};
  };
  const ambiguous = session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  await flush(); clock.advance(10000);
  assert.equal((await ambiguous).outcome, 'unconfirmed');
  await flush(); assert.equal(session.state.connection.get().phase, 'ready');
  // The unresolved placement keeps its symbol's key until its reconciliation ends.
  await assert.rejects(session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } }), error => error.code === 'operation-pending');
  for (let second = 0; second < 60; second++) { clock.advance(1000); await flush(); }
  broker.placeOrder = async order => {
    host.orderUpdate({ ...order, id: 'far', status: 6, limitPrice: 10.02 });
    host.orderUpdate({ ...order, id: 'close', status: 6, limitPrice: 10.004 });
    return {};
  };
  const unique = await session.commands.place({ context: session.commands.context(), order: { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 } });
  assert.equal(unique.outcome, 'confirmed'); assert.deepEqual(unique.entityIds, ['close']);
  session.destroy();
});
test('A02: refresh while disconnected rejects so a retry control can report it', async () => {
  const { session, host, broker } = fixture(); await session.ready;
  broker.connectionStatus = () => 3; host.connectionStatusUpdate(3);
  await assert.rejects(session.refresh(), error => error.code === 'disconnected');
  session.destroy();
});
test('P01: profit and loss for an unknown position is dropped instead of accumulating', async () => {
  const { session, host } = fixture(); await session.ready;
  host.plUpdate('unknown', 5); host.individualPositionPLUpdate('unknown', 6);
  assert.equal(session.state.tablePL.get('unknown'), undefined);
  assert.equal(session.state.individualTablePL.get('unknown'), undefined);
  session.destroy();
});
test('P01/A04: position profit updates replay after the in-flight snapshot and position pushes', async () => {
  const positions = deferred(), individuals = deferred();
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
  const individual = { id: 'I', symbol: 'X', side: 1, qty: 2, price: 10, date: 1 };
  const { session, host } = fixture(broker => {
    broker.positions = () => positions.promise;
    broker.individualPositions = () => individuals.promise;
  }, { brokerConfig: { configFlags: { supportPositions: true, supportPositionNetting: true } } });
  await flush();
  host.positionUpdate(position); host.plUpdate('P', 7);
  host.individualPositionUpdate(individual); host.individualPositionPLUpdate('I', 8);
  positions.resolve([]); individuals.resolve([]); await session.ready;
  assert.equal(session.state.tablePL.get('P')?.value, 7);
  assert.equal(session.state.individualTablePL.get('I')?.value, 8);
  session.destroy();
});
test('A04: malformed position rows are quarantined alongside valid positions', async () => {
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
  const diagnostics = [];
  const { session } = fixture(broker => { broker.positions = async () => [position, null]; },
    { brokerConfig: { configFlags: { supportPositions: true } }, diagnostics: value => diagnostics.push(value) });
  await session.ready;
  assert.deepEqual(session.state.positions.ids(), ['P']);
  assert.deepEqual(session.datasets.positions.get(), { status: 'ready', warnings: 1 });
  assert.equal(diagnostics[0].method, 'positions');
  session.destroy();
});
test('P01/A04: a position opened and closed during snapshot replay leaves no orphaned profit', async () => {
  const positions = deferred();
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
  const { session, host } = fixture(broker => { broker.positions = () => positions.promise; },
    { brokerConfig: { configFlags: { supportPositions: true } } });
  await flush();
  host.positionUpdate(position); host.plUpdate('P', 7); host.positionUpdate({ ...position, qty: 0 });
  positions.resolve([]); await session.ready;
  assert.equal(session.state.positions.get('P'), undefined);
  assert.equal(session.state.tablePL.get('P'), undefined);
  session.destroy();
});
test('X07: invalid host pushes become one diagnostic each and never throw into the adapter', async () => {
  const diagnostics = [], logs = [];
  const { session, host } = fixture(undefined, { diagnostics: value => diagnostics.push(value), debugBroker: 'host-only', debugLogger: (...args) => logs.push(args) });
  await session.ready;
  class Price { constructor() { this.value = 1; } }
  assert.doesNotThrow(() => host.orderUpdate({ ...baseOrder, id: 'dated', updateTime: new Date() }));
  assert.doesNotThrow(() => host.orderUpdate({ ...baseOrder, id: 'classy', limitPrice: new Price() }));
  assert.doesNotThrow(() => host.orderUpdate({ ...baseOrder, id: 'unknown-status', status: 99 }));
  assert.doesNotThrow(() => host.equityUpdate(Number.NaN));
  assert.deepEqual(diagnostics.map(value => [value.source, value.method, value.entityId]), [
    ['host', 'orderUpdate', 'dated'], ['host', 'orderUpdate', 'classy'], ['host', 'orderUpdate', 'unknown-status'], ['host', 'equityUpdate', undefined],
  ]);
  assert(diagnostics.every(value => typeof value.message === 'string' && value.message.length));
  for (const id of ['dated', 'classy', 'unknown-status']) assert.equal(session.state.orders.get(id), undefined);
  assert.equal(logs.filter(([message]) => message.includes('dropped')).length, 4, 'debug_broker logging includes the drops');
  session.destroy();
});
test('X07: invalid synchronous preference input and settings failures are reported, not thrown at the adapter', async () => {
  const diagnostics = [];
  let failSettings = false;
  const { session, host } = fixture(undefined, {
    diagnostics: value => diagnostics.push(value),
    settings: { get: () => undefined, set: () => { if (failSettings) throw new Error('storage full'); }, remove: () => {} },
  });
  await session.ready;
  assert.doesNotThrow(() => host.setQty('X', 0));
  assert.doesNotThrow(() => host.setQty('X', Number.NaN));
  assert.equal(await host.getQty('X'), 2, 'rejected quantities leave the default in place');
  failSettings = true;
  assert.doesNotThrow(() => host.silentOrdersPlacement().setValue(true));
  assert.equal(host.silentOrdersPlacement().value(), true, 'the value still changes when persistence fails');
  assert.doesNotThrow(() => host.setQty('X', 5));
  assert.equal(await host.getQty('X'), 5);
  assert.deepEqual(diagnostics.map(value => [value.source, value.method]), [
    ['host', 'setQty'], ['host', 'setQty'], ['host', 'silentOrdersPlacement'], ['host', 'setQty'],
  ]);
  session.destroy();
});
test('X07/A01: an invalid constructor push is reported when it replays and does not fail hydration', async () => {
  const diagnostics = [];
  const { session } = fixture((broker, host) => { host.orderUpdate({ ...baseOrder, id: 'bad', status: 99 }); }, { diagnostics: value => diagnostics.push(value) });
  await session.ready;
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.deepEqual(diagnostics.map(value => value.entityId), ['bad']);
  session.destroy();
});
test('A04: a snapshot with some invalid rows commits the valid ones, keeps quarantined IDs and reports each', async () => {
  const diagnostics = [];
  let rows = [baseOrder, { ...baseOrder, id: 'second', limitPrice: 11 }];
  const { session } = fixture(broker => { broker.orders = async () => rows; }, { diagnostics: value => diagnostics.push(value) });
  await session.ready;
  rows = [{ ...baseOrder, limitPrice: 12 }, { ...baseOrder, id: 'second', status: 99 }, { ...baseOrder, id: 'third', limitPrice: Number.NaN }, { ...baseOrder, id: 'fourth' }];
  await session.refresh();
  assert.equal(session.state.orders.get('O').limitPrice, 12);
  assert.equal(session.state.orders.get('second').limitPrice, 11, 'a quarantined ID keeps its previous value');
  assert.equal(session.state.orders.get('third'), undefined);
  assert.ok(session.state.orders.get('fourth'));
  assert.deepEqual(session.datasets.orders.get(), { status: 'ready', warnings: 2 });
  assert.deepEqual(diagnostics.map(value => [value.source, value.method, value.entityId]), [['snapshot', 'orders', 'second'], ['snapshot', 'orders', 'third']]);
  rows = [{ ...baseOrder, status: 99 }];
  await assert.rejects(session.refresh());
  assert.equal(session.datasets.orders.get().status, 'error', 'a read with no valid rows still fails');
  session.destroy();
});
test('O02: a BrokerRejection keeps the broker message in the error and pending record; other errors stay generic', async () => {
  const { session, broker } = fixture(); await session.ready;
  broker.placeOrder = async () => { throw { code: 'rejected', message: 'Insufficient margin.' }; };
  const order = { symbol: 'X', side: 1, qty: 2, type: 1, limitPrice: 10 };
  await assert.rejects(session.commands.place({ context: session.commands.context(), order }), error => error.code === 'broker-rejected' && error.message === 'Insufficient margin.');
  const records = () => session.pending.ids().map(id => session.pending.get(id));
  assert.equal(records().at(-1).error, 'Insufficient margin.');
  broker.placeOrder = async () => { throw Object.assign(new Error('Market closed.'), { code: 'unavailable' }); };
  await assert.rejects(session.commands.place({ context: session.commands.context(), order }), error => error.code === 'broker-unavailable' && error.message === 'Market closed.');
  broker.placeOrder = async () => { throw new Error('socket hang up at 10.0.0.4'); };
  await assert.rejects(session.commands.place({ context: session.commands.context(), order }), error => error.code === 'broker-rejected' && error.message === 'The broker could not complete the operation.');
  broker.placeOrder = async () => { throw { code: 'ECONNRESET', message: 'internal' }; };
  await assert.rejects(session.commands.place({ context: session.commands.context(), order }), error => error.message === 'The broker could not complete the operation.');
  session.destroy();
});
test('A04/X09: an oversized history read keeps the newest rows and reports the trim', async () => {
  const diagnostics = [];
  const rows = Array.from({ length: 12 }, (_, index) => ({ ...baseOrder, id: `H${index}`, status: 2, updateTime: 1000 + ((index * 7) % 12) }));
  const { session } = fixture(broker => { broker.ordersHistory = async () => rows; }, { historyLimit: 5, diagnostics: value => diagnostics.push(value), brokerConfig: { configFlags: { supportOrdersHistory: true } } });
  await session.ready;
  const kept = session.state.history.ids().map(id => session.state.history.get(id).updateTime).sort();
  assert.deepEqual(kept, [1007, 1008, 1009, 1010, 1011]);
  assert.deepEqual(diagnostics.map(value => [value.source, value.method]), [['history', 'ordersHistory']]);
  session.destroy();
});
test('A04: history rows without update times keep the latest arrivals', async () => {
  const { limitHistory } = await loadModule('src/core/history-limit.ts');
  const result = limitHistory([{ id: 'a' }, { id: 'b' }, { id: 'c', updateTime: 5 }], 2);
  assert.deepEqual(result.rows.map(row => row.id), ['b', 'c']); assert.equal(result.dropped, 1);
  assert.equal(limitHistory([{ id: 'a' }], 2).dropped, 0);
});
test('A02: repeated Connected notifications coalesce into one hydration; a real reconnect still re-reads', async () => {
  let metadata = 0, orders = 0;
  const { session, host, broker } = fixture(broker => {
    const accounts = broker.accountsMetainfo;
    broker.accountsMetainfo = () => { metadata++; return accounts(); };
    broker.orders = async () => { orders++; return [baseOrder]; };
  });
  await session.ready;
  const [beforeMetadata, beforeOrders] = [metadata, orders];
  host.connectionStatusUpdate(1); host.connectionStatusUpdate(1); await flush();
  assert.deepEqual([metadata - beforeMetadata, orders - beforeOrders], [0, 0], 'a duplicate Connected while ready reads nothing');
  broker.connectionStatus = () => 3; host.connectionStatusUpdate(3);
  broker.connectionStatus = () => 1; host.connectionStatusUpdate(1); host.connectionStatusUpdate(1); host.connectionStatusUpdate(1);
  await flush(); await flush();
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.deepEqual([metadata - beforeMetadata, orders - beforeOrders], [1, 1], 'one hydration for the reconnect');
  session.destroy();
});
test('A01/A04: account datasets start only the snapshot reads the capabilities call for', async () => {
  const { createAccountDatasets } = await loadModule('src/core/account-datasets.ts');
  const { createTradingState } = await loadModule('src/core/trading-state.ts');
  const state = createTradingState(), clock = new ManualClock(), reads = [];
  const broker = { orders: async () => { reads.push('orders'); return []; }, ordersHistory: async () => { reads.push('history'); return []; }, positions: async () => { reads.push('positions'); return []; }, individualPositions: async () => { reads.push('individual'); return []; } };
  const datasets = createAccountDatasets({ state, broker: () => broker, clock, diagnostic: () => {}, deadline: 15000 });
  await Promise.all(datasets.beginSnapshots({ supportOrdersHistory: false, supportPositions: true, supportPositionNetting: false }));
  assert.deepEqual(reads, ['orders', 'positions']);
  datasets.destroy(); state.destroy(); assert.equal(clock.timers.size, 0);
});
test('A02: the notified status wins over a getter the adapter has not flipped yet, so a real drop re-reads', async () => {
  let metadata = 0;
  const { session, host, broker } = fixture(broker => { const accounts = broker.accountsMetainfo; broker.accountsMetainfo = () => { metadata++; return accounts(); }; });
  await session.ready;
  const before = metadata;
  // The getter still says Connected when the adapter announces the drop.
  host.connectionStatusUpdate(3);
  assert.equal(session.state.connection.get().phase, 'disconnected');
  broker.connectionStatus = () => 1; host.connectionStatusUpdate(1); await flush(); await flush();
  assert.equal(session.state.connection.get().phase, 'ready');
  assert.equal(metadata - before, 1, 'one new hydration after the drop');
  session.destroy();
});
test('A02: a duplicate Connected is coalesced inside the read deadline and re-reads after it', async () => {
  let metadata = 0;
  const { session, host, clock } = fixture(broker => { const accounts = broker.accountsMetainfo; broker.accountsMetainfo = () => { metadata++; return accounts(); }; }, { deadlines: { read: 5000 } });
  await session.ready;
  const before = metadata;
  host.connectionStatusUpdate(1); await flush();
  assert.equal(metadata - before, 0, 'inside the window: no reads');
  clock.advance(5000);
  host.connectionStatusUpdate(1); await flush(); await flush();
  assert.equal(metadata - before, 1, 'after the window: one resync hydration');
  assert.equal(session.state.connection.get().phase, 'ready');
  session.destroy();
});
test('A04: a row quarantined on two consecutive reads is removed after the second; a valid read clears its history', async () => {
  let rows = [baseOrder, { ...baseOrder, id: 'flaky', limitPrice: 11 }];
  const { session } = fixture(broker => { broker.orders = async () => rows; });
  await session.ready;
  rows = [baseOrder, { ...baseOrder, id: 'flaky', status: 99 }];
  await session.refresh();
  assert.equal(session.state.orders.get('flaky')?.limitPrice, 11, 'kept for one read');
  await session.refresh();
  assert.equal(session.state.orders.get('flaky'), undefined, 'removed when quarantined again');
  assert.deepEqual(session.datasets.orders.get(), { status: 'ready', warnings: 1 });
  rows = [baseOrder, { ...baseOrder, id: 'flaky', limitPrice: 13 }];
  await session.refresh();
  assert.equal(session.state.orders.get('flaky').limitPrice, 13);
  assert.deepEqual(session.datasets.orders.get(), { status: 'ready' });
  rows = [baseOrder, { ...baseOrder, id: 'flaky', status: 99 }];
  await session.refresh();
  assert.equal(session.state.orders.get('flaky')?.limitPrice, 13, 'a fresh quarantine keeps the value again for one read');
  session.destroy();
});
test('P02/X07: a futures instrument without a point value is reported once when P&L uses its own currency', async () => {
  const diagnostics = [];
  let futures = { ...instrument, type: 'futures', currency: 'USDT' };
  const { session } = fixture(broker => { broker.symbolInfo = async () => futures; },
    { brokerConfig: { configFlags: { positionPLInInstrumentCurrency: true } }, diagnostics: value => diagnostics.push(value) });
  await session.ready;
  await session.symbolInfo('PERP');
  await session.symbolInfo('PERP');
  assert.equal(diagnostics.length, 1);
  assert.deepEqual({ ...diagnostics[0], message: undefined }, { source: 'instrument', method: 'symbolInfo', entityId: 'PERP', message: undefined });
  assert.match(diagnostics[0].message, /no point value \(bigPointValue\)/);
  futures = { ...futures, bigPointValue: 1 };
  await session.symbolInfo('PERP2');
  assert.equal(diagnostics.length, 1, 'a point value is enough');
  session.destroy();

  const plain = [];
  const other = fixture(broker => { broker.symbolInfo = async () => ({ ...instrument, type: 'futures' }); }, { diagnostics: value => plain.push(value) });
  await other.session.ready; await other.session.symbolInfo('PERP');
  assert.deepEqual(plain, [], 'account-currency P&L uses pip values instead');
  other.session.destroy();
});
