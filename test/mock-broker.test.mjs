import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { OrderStatus, OrderType, ParentType, Side } = await loadModule('src/contracts/broker.ts');
const { simulationProfiles } = await loadModule('src/mock/scenarios.ts');
const { createTradingSession } = await loadModule('src/core/session.ts');
function sessionFor(simulation) {
  const settings = new Map();
  return createTradingSession({ ...simulation, settingsKey: 'simulation-test', settings: mapSettings(settings), formatters: stringFormatters });
}
const order = { symbol: 'SIM:X', side: 1, qty: 2, type: 1, limitPrice: 100 };
test('A01/O01: every mock profile places, modifies and cancels through real broker state', async () => {
  for (const profile of simulationProfiles) {
    const simulation = createDeterministicBroker({ profile, seed: 10 }); const session = sessionFor(simulation); await session.ready;
    const placed = await session.commands.place({ context: session.commands.context(), order });
    const id = placed.entityIds[0]; assert.equal(session.state.orders.get(id).status, 6, profile);
    const modified = { ...session.state.orders.get(id), limitPrice: 99 };
    assert.equal((await session.commands.modify({ context: session.commands.context(id), order: modified })).outcome, 'confirmed');
    assert.equal((await session.commands.cancel({ context: session.commands.context(id), id })).outcome, 'confirmed');
    assert.equal(session.state.orders.get(id).status, 1);
    assert.deepEqual(simulation.controls.calls().filter(call => ['placeOrder', 'modifyOrder', 'cancelOrder'].includes(call.method)).map(call => call.method), ['placeOrder', 'modifyOrder', 'cancelOrder']);
    session.destroy(); assert.deepEqual(simulation.controls.subscriptionCounts(), { equity: 0, margin: 0, pip: 0, quotes: 0, depth: 0 });
  }
});
test('O06/B01: scripted partial/full fills emit distinct executions and activate broker-linked brackets', async () => {
  const simulation = createDeterministicBroker(), session = sessionFor(simulation); await session.ready;
  const placed = await session.commands.place({ context: session.commands.context(), order: { ...order, takeProfit: 110, stopLoss: 90 } });
  const id = placed.entityIds[0], children = session.state.orders.ids().filter(key => session.state.orders.get(key).parentId === id);
  assert.equal(children.length, 2); for (const child of children) assert.equal(session.state.orders.get(child).status, 3);
  simulation.controls.fill(id, 1, 100); await flush(); assert.equal(session.state.orders.get(id).filledQty, 1); assert.equal(session.state.orders.get(id).status, 6);
  for (const child of children) assert.equal(session.state.orders.get(child).parentType, 2);
  simulation.controls.fill(id, 1, 101); await flush(); assert.equal(session.state.orders.get(id).status, 2); assert.equal(session.state.executions.ids().length, 2);
  assert.equal(session.state.positions.get('simulation-A:net:SIM:X').qty, 6); session.destroy();
});
test('X08: identical seeds/actions produce identical IDs, timestamps, quotes and broker calls', async () => {
  const results = [];
  for (let i = 0; i < 2; i++) {
    const simulation = createDeterministicBroker({ seed: 123 }), session = sessionFor(simulation); await session.ready;
    const placed = await session.commands.place({ context: session.commands.context(), order }); simulation.controls.fill(placed.entityIds[0]);
    results.push({ calls: simulation.controls.calls(), executions: session.state.executions.ids().map(id => session.state.executions.get(id)), ticks: [simulation.controls.tick(), simulation.controls.tick()] }); session.destroy();
  }
  assert.deepEqual(results[0], results[1]);
});
test('O02/O03: rejection and delayed acceptance are explicit scenarios with no network or retry dispatch', async () => {
  const simulation = createDeterministicBroker(), session = sessionFor(simulation); await session.ready;
  simulation.controls.rejectNextOperation('No simulated funds');
  await assert.rejects(session.commands.place({ context: session.commands.context(), order }), error => error.code === 'broker-rejected');
  simulation.controls.delayNextAcknowledgement(20000);
  const placing = session.commands.place({ context: session.commands.context(), order }); await flush(); simulation.clock.advance(10000);
  assert.equal((await placing).outcome, 'unconfirmed'); simulation.clock.advance(10000); await flush();
  assert.equal(simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 2); session.destroy();
});
test('P03/D04: session market and financial demand release on account change, reacquire once, and fully dispose', async () => {
  const simulation = createDeterministicBroker(), session = sessionFor(simulation); await session.ready;
  const quotes = [], depth = [];
  const firstQuote = session.acquireQuotes('SIM:X', 'fast', value => quotes.push(value));
  const secondQuote = session.acquireQuotes('SIM:X', 'fast', () => {});
  const firstEquity = session.acquireFinancial('equity'), secondEquity = session.acquireFinancial('equity', 'OTHER:SYMBOL');
  const margin = session.acquireFinancial('margin', 'SIM:X'), pip = session.acquireFinancial('pip', 'SIM:X');
  const book = session.acquireDepth('SIM:X', value => depth.push(value)); await flush(); await flush();
  assert.deepEqual(simulation.controls.subscriptionCounts(), { equity: 1, margin: 1, pip: 1, quotes: 1, depth: 1 });
  assert.equal(session.state.equity.get(), 10000); assert.equal(session.state.quotes.get('SIM:X').trade, 100); assert.equal(depth.length, 1);
  await session.commands.selectAccount('simulation-B'); await flush(); await flush();
  assert.equal(session.state.equity.get(), 15000); assert.deepEqual(simulation.controls.subscriptionCounts(), { equity: 1, margin: 1, pip: 1, quotes: 1, depth: 1 });
  firstQuote(); firstEquity(); await flush(); assert.equal(simulation.controls.subscriptionCounts().quotes, 1); assert.equal(simulation.controls.subscriptionCounts().equity, 1);
  secondQuote(); secondEquity(); margin(); pip(); book(); session.destroy();
  assert.deepEqual(simulation.controls.subscriptionCounts(), { equity: 0, margin: 0, pip: 0, quotes: 0, depth: 0 });
});


test('B03: simulated singular/paired cancellation reports child and parent changes through one called-ID command', async () => {
  for (const paired of [false, true]) {
    const simulation = createDeterministicBroker(), session = sessionFor(simulation);
    try {
      await session.ready; simulation.controls.patchCapabilities({ supportCancellingBothBracketsOnly: paired });
      const placed = await session.commands.place({ context: session.commands.context(), order: { ...order, takeProfit: 110, stopLoss: 90 } }), parentId = placed.entityIds[0];
      const children = simulation.controls.snapshot().orders.filter(child => child.parentId === parentId), take = children.find(child => child.type === OrderType.Limit), stop = children.find(child => child.type === OrderType.Stop);
      const result = await session.commands.cancel({ id: take.id, context: session.commands.context(take.id) });
      assert.equal(result.outcome, 'confirmed'); assert.equal(session.state.orders.get(take.id).status, OrderStatus.Canceled); assert.equal(session.state.orders.get(stop.id).status, paired ? OrderStatus.Canceled : OrderStatus.Inactive);
      const parent = session.state.orders.get(parentId); assert.equal(parent.takeProfit, undefined); assert.equal(parent.stopLoss, paired ? undefined : 90); assert.equal(parent.qty, 2);
      const calls = simulation.controls.calls().filter(call => call.method === 'cancelOrder'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, [take.id]);
    } finally { session.destroy(); }
  }
});

test('B03/B04: paired cancellation removes only its exit level and preserves other allocation identities', async () => {
  const simulation = createDeterministicBroker(), session = sessionFor(simulation);
  try {
    await session.ready; simulation.controls.patchCapabilities({ supportCancellingBothBracketsOnly: true });
    const levels = [{ id: 'first', qty: 2, takeProfit: 110, stopLoss: 90 }, { id: 'second', qty: 2, takeProfit: 120, trailingStopPips: 10 }];
    const placed = await session.commands.place({ context: session.commands.context(), order: { ...order, qty: 4, exitLevels: levels } }), parentId = placed.entityIds[0];
    const children = simulation.controls.snapshot().orders.filter(child => child.parentId === parentId), called = children.find(child => child.exitLevelId === 'first' && child.type === OrderType.Limit);
    await session.commands.cancel({ id: called.id, context: session.commands.context(called.id) });
    assert.deepEqual(session.state.orders.get(parentId).exitLevels, [levels[1]]); assert.equal(session.state.orders.get(parentId).qty, 4);
    for (const child of children) assert.equal(session.state.orders.get(child.id).status, child.exitLevelId === 'first' ? OrderStatus.Canceled : OrderStatus.Inactive);
  } finally { session.destroy(); }
});

test('B03/B06: canceling a parent cancels inactive children and bulk paired selection sends one broker operation', async () => {
  for (const bulk of [false, true]) {
    const simulation = createDeterministicBroker(), session = sessionFor(simulation);
    try {
      await session.ready; simulation.controls.patchCapabilities({ supportCancellingBothBracketsOnly: true });
      const placed = await session.commands.place({ context: session.commands.context(), order: { ...order, takeProfit: 110, stopLoss: 90 } }), parentId = placed.entityIds[0];
      const children = simulation.controls.snapshot().orders.filter(child => child.parentId === parentId);
      if (bulk) {
        const result = await session.commands.cancelMany({ context: session.commands.context(), symbol: 'SIM:X', side: Side.Sell, orders: children.map(child => ({ id: child.id, revision: session.state.orders.revision(child.id) })) });
        assert(result.every(value => value.result.outcome === 'confirmed')); assert.equal(simulation.controls.calls().filter(call => call.method === 'cancelOrders').length, 1);
        assert.equal(session.state.orders.get(parentId).takeProfit, undefined); assert.equal(session.state.orders.get(parentId).stopLoss, undefined);
      } else {
        await session.commands.cancel({ id: parentId, context: session.commands.context(parentId) }); assert.equal(session.state.orders.get(parentId).status, OrderStatus.Canceled);
      }
      for (const child of children) assert.equal(session.state.orders.get(child.id).status, OrderStatus.Canceled);
      assert.equal(simulation.controls.calls().filter(call => call.method === 'cancelOrder').length, bulk ? 0 : 1);
    } finally { session.destroy(); }
  }
});

test('B03: canceled protection updates the owning net or individual position without closing it', async () => {
  for (const individual of [false, true]) {
    const simulation = createDeterministicBroker({ profile: individual ? 'fx-netting' : 'equity-net' }), session = sessionFor(simulation);
    try {
      await session.ready; simulation.controls.patchCapabilities({ supportCancellingBothBracketsOnly: true });
      const store = individual ? session.state.individualPositions : session.state.positions, id = store.ids()[0], before = store.get(id);
      await session.commands.editProtection({ id, individual, context: session.commands.context(id, individual ? 'individualPosition' : 'position'), brackets: { takeProfit: 110, guaranteedStop: 90 } });
      const child = simulation.controls.snapshot().orders.find(value => value.parentId === id && value.type === OrderType.Limit);
      await session.commands.cancel({ id: child.id, context: session.commands.context(child.id) });
      assert.equal(store.get(id).qty, before.qty); assert.equal(store.get(id).takeProfit, undefined); assert.equal(store.get(id).guaranteedStop, undefined);
      assert(simulation.controls.snapshot().orders.filter(value => value.parentId === id).every(value => value.status === OrderStatus.Canceled));
    } finally { session.destroy(); }
  }
});


test('B01/B06: canceling an unfilled parent remainder preserves protection already reparented to the filled position', async () => {
  const simulation = createDeterministicBroker(), session = sessionFor(simulation);
  try {
    await session.ready;
    const placed = await session.commands.place({ context: session.commands.context(), order: { ...order, takeProfit: 110, stopLoss: 90 } }), parentId = placed.entityIds[0];
    simulation.controls.fill(parentId, 1, 100);
    const children = simulation.controls.snapshot().orders.filter(child => child.parentType === ParentType.Position), position = simulation.controls.snapshot().positions[0];
    assert.equal(children.length, 2); assert(children.every(child => child.status === OrderStatus.Working));
    await session.commands.cancel({ id: parentId, context: session.commands.context(parentId) });
    assert.equal(session.state.orders.get(parentId).status, OrderStatus.Canceled);
    assert.equal(session.state.positions.get(position.id).qty, position.qty);
    for (const child of children) assert.equal(session.state.orders.get(child.id).status, OrderStatus.Working);
  } finally { session.destroy(); }
});
