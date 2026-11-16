import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred, flush } from './manual-clock.mjs';
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { protectionFromChildEdit } = await loadModule('src/core/bracket-modification.ts');
const { protectionDirectionError } = await loadModule('src/core/protection-rules.ts');
const { OrderType, Side, ParentType, StopType, OrderStatus } = await loadModule('src/contracts/broker.ts');
test('exit direction checks both sides and all allocated levels', () => {
  for (const side of [Side.Buy, Side.Sell]) {
    assert.equal(protectionDirectionError({takeProfit: 100 + side, stopLoss: 100 - side}, side, 100), undefined);
    assert.match(protectionDirectionError({takeProfit: 100 - side}, side, 100), /Take profit/);
    assert.match(protectionDirectionError({stopLoss: 100 + side}, side, 100), /Stop loss/);
    assert.match(protectionDirectionError({exitLevels: [{id: 'x', qty: 1, guaranteedStop: 100}]}, side, 100), /Stop loss/);
  }
});
async function fixture(called = false, configure, flags = {}, profile = "equity-net", protection) {
  const simulation = createDeterministicBroker({profile});
  Object.assign(simulation.brokerConfig.configFlags, { supportModifyOrderPreview: true, ...flags });
  let host;
  const settings = new Map();
  const session = createTradingSession({ ...simulation,
    enabledFeatures: called ? ['always_pass_called_order_to_modify'] : [],
    brokerFactory: value => { host = value; const broker = simulation.brokerFactory(value); configure?.(broker, value); return broker; },
    settings: mapSettings(settings),
    formatters: stringFormatters,
  });
  await session.ready;
  const releaseQuotes = session.acquireQuotes("SIM:X", "fast", () => {});
  await flush();
  const placed = await session.commands.place({ context: session.commands.context(), order: {
    symbol: 'SIM:X', type: OrderType.Limit, side: Side.Buy, qty: 4, limitPrice: 100,
    ...(protection ?? {exitLevels: [{ id: 'first', qty: 2, takeProfit: 102, stopLoss: 99 }, { id: 'second', qty: 1, takeProfit: 104, stopLoss: 98 }]}),
  } });
  const parent = session.state.orders.get(placed.entityIds[0]);
  const child = (type, level = 'first') => session.state.orders.ids().map(id => session.state.orders.get(id)).find(value => value.parentId === parent.id && value.exitLevelId === level && value.type === type);
  return { session, simulation, host, parent, child, releaseQuotes };
}
for (const called of [false, true]) for (const type of [OrderType.Limit, OrderType.Stop]) {
  test(`B04/U04: called-order flag ${called} routes ${type === OrderType.Limit ? 'TP' : 'SL'} preview and dispatch consistently`, async () => {
    const f = await fixture(called);
    try {
      const child = f.child(type), field = type === OrderType.Limit ? 'limitPrice' : 'stopPrice';
      const changed = { ...child, [field]: type === OrderType.Limit ? 103 : 97, qty: 1 };
      const request = { context: f.session.commands.context(child.id), order: changed };
      assert(Object.isFrozen(request.context.parent));
      const lease = await f.session.commands.preview(request);
      const result = await f.session.commands.modify({ ...request, previewToken: lease.token, confirmId: lease.preview.confirmId });
      assert.equal(result.outcome, 'confirmed');
      const preview = f.simulation.controls.calls().filter(value => value.method === 'previewOrder').at(-1).args[0];
      const sent = f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').at(-1).args[0];
      assert.deepEqual(sent, preview);
      assert.equal(sent.id, called ? child.id : f.parent.id);
      if (called) { assert.equal(sent[field], changed[field]); assert.equal(sent.parentId, f.parent.id); }
      else {
        assert.equal(sent.qty, 4);
        assert.equal(sent.exitLevels[0].qty, 1);
        assert.equal(sent.exitLevels[0][type === OrderType.Limit ? 'takeProfit' : 'stopLoss'], changed[field]);
        assert.deepEqual(sent.exitLevels[1], f.parent.exitLevels[1]);
        assert.deepEqual(result.entityIds, [f.parent.id]);
      }
      const latestParent = f.session.state.orders.get(f.parent.id);
      assert.equal(latestParent.exitLevels[0].qty, 1);
      assert.equal(latestParent.exitLevels[0][type === OrderType.Limit ? 'takeProfit' : 'stopLoss'], changed[field]);
      const active = f.simulation.controls.snapshot().orders.filter(value => [OrderStatus.Working, OrderStatus.Inactive].includes(value.status));
      assert.equal(active.filter(value => value.parentId === child.id).length, 0, 'a called child never becomes a new protection parent');
      assert(active.filter(value => value.parentId === f.parent.id && value.exitLevelId === 'first').every(value => value.qty === 1));
      assert.equal(f.parent.exitLevels[0].qty, 2, 'provider-owned source is immutable');
      for (let fill = 0; fill < 2; fill++) {
        f.simulation.controls.fill(f.parent.id, 2, 100);
        const activated = f.simulation.controls.snapshot().orders.filter(value => value.exitLevelId === 'first' && value.status === OrderStatus.Working);
        assert.equal(activated.length, 2);
        assert(activated.every(value => value.qty === 1), 'later fills must not restore an obsolete allocation');
      }
      const positionChild = f.simulation.controls.snapshot().orders.find(value => value.exitLevelId === 'first' && value.status === OrderStatus.Working && value.type === OrderType.Limit);
      const positionRequest = {context: f.session.commands.context(positionChild.id), order: {...positionChild, limitPrice: 105}};
      const positionLease = await f.session.commands.preview(positionRequest);
      const positionResult = await f.session.commands.modify({...positionRequest, previewToken: positionLease.token, confirmId: positionLease.preview.confirmId});
      assert.equal(positionResult.outcome, 'confirmed');
      const owner = f.session.state.positions.get(positionChild.parentId);
      assert.equal(owner.qty, 8);
      assert.equal(owner.exitLevels[0].qty, 1);
      assert.equal(owner.exitLevels[0].takeProfit, 105);
      assert.equal(owner.exitLevels[1].qty, 1);

    } finally { f.releaseQuotes(); f.session.destroy(); }
  });
}
test('B04/A04: parent revisions fence edits across metadata, previews and dispatch', async () => {
  for (const phase of ['metadata', 'preview', 'dispatch']) {
    const pending = deferred(); let delay = false, entered = false;
    const f = await fixture(false, broker => {
      if (phase === 'metadata') broker.getOrderDialogOptions = async () => { if (delay) { entered = true; return pending.promise; } return {}; };
      if (phase === 'preview') { const original = broker.previewOrder; broker.previewOrder = async order => { entered = true; await pending.promise; return original.call(broker, order); }; }
    }, { supportModifyOrderPreview: phase === "preview" });
    let release;
    try {
      const child = f.child(OrderType.Limit);
      const request = { context: f.session.commands.context(child.id), order: { ...child, limitPrice: 103 } };
      if (phase === 'metadata') delay = true;
      if (phase === 'dispatch') release = f.session.pending.subscribeChanges(() => f.host.orderUpdate({ ...f.parent, last: 101 }));
      const work = phase === 'preview' ? f.session.commands.preview(request) : f.session.commands.modify(request);
      const rejected = assert.rejects(work, {code: 'stale-context'});
      if (phase !== 'dispatch') {
        for (let attempt = 0; !entered && attempt < 20; attempt++) await flush();
        assert.equal(entered, true, phase);
        f.host.orderUpdate({ ...f.parent, last: 101 }); pending.resolve({});
      }
      await rejected;
      assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 0);
    } finally { release?.(); f.releaseQuotes(); f.session.destroy(); }
  }
});
test('B04/U04: an old parent preview cannot be borrowed with a fresh context', async () => {
  const f = await fixture();
  try {
    const child = f.child(OrderType.Limit);
    const request = { context: f.session.commands.context(child.id), order: { ...child, limitPrice: 103 } };
    const lease = await f.session.commands.preview(request);
    f.host.orderUpdate({ ...f.parent, last: 101 });
    await assert.rejects(f.session.commands.modify({ ...request, context: f.session.commands.context(child.id), previewToken: lease.token, confirmId: lease.preview.confirmId }), /Review the current order/);
    assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 0);
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B04: child linkage, type and status cannot be rewritten, and bracket permission controls child price changes', async () => {
  const f = await fixture();
  try {
    const child = f.child(OrderType.Limit);
    for (const patch of [{parentId: 'other'}, {parentType: ParentType.Position}, {exitLevelId: 'second'}, {type: OrderType.Stop}, {status: OrderStatus.Filled}])
      await assert.rejects(f.session.commands.modify({context: f.session.commands.context(child.id), order: {...child, ...patch, limitPrice: 103}}), {code: 'invalid-input'});
    f.session.host.patchConfig({supportModifyBrackets: false, supportModifyOrderPrice: true});
    await assert.rejects(f.session.commands.modify({context: f.session.commands.context(child.id), order: {...child, limitPrice: 103}}), {code: 'unsupported'});
    assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 0);
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B04/B05: child translation preserves siblings and supports exclusive stop styles without inventing legacy allocation identities', () => {
  const parent = {qty: 4, takeProfit: 103, stopLoss: 99};
  const child = {id: 'sl', parentId: 'p', parentType: ParentType.Order, symbol: 'SIM:X', side: Side.Sell, type: OrderType.Stop, qty: 4, stopPrice: 99};
  const guaranteed = protectionFromChildEdit(parent, child, {...child, stopType: StopType.GuaranteedStop, stopPrice: 98});
  assert.equal(guaranteed.takeProfit, 103); assert.equal(guaranteed.guaranteedStop, 98); assert.equal(guaranteed.stopLoss, undefined);
  const trailing = protectionFromChildEdit(parent, child, {...child, stopType: StopType.TrailingStop, trailingStopPips: 50});
  assert.equal(trailing.trailingStopPips, 50); assert.equal(trailing.stopLoss, undefined);
  assert.throws(() => protectionFromChildEdit(parent, child, {...child, qty: 2}), /parent quantity/);
  assert.throws(() => protectionFromChildEdit(parent, child, {...child, stopType: StopType.TrailingStop, stopPrice: 98, trailingStopPips: 50}), /trailing distance/);
});

for (const individual of [false, true]) for (const called of [false, true]) {
  test(`B04/U04: ${individual ? 'individual' : 'net'} position bracket edits use the position API with called flag ${called}`, async () => {
    const f = await fixture(called, undefined, {}, individual ? 'fx-netting' : 'equity-net');
    try {
      const store = individual ? f.session.state.individualPositions : f.session.state.positions;
      const position = store.get(store.ids()[0]);
      await f.session.commands.editProtection({ context: f.session.commands.context(position.id, individual ? 'individualPosition' : 'position'), id: position.id, individual,
        brackets: { exitLevels: [{id: 'position-first', qty: 2, takeProfit: 103, stopLoss: 98}, {id: 'position-second', qty: 1, takeProfit: 104, stopLoss: 97}] } });
      f.session.host.patchConfig({supportModifyBrackets: false});
      const child = f.session.state.orders.ids().map(id => f.session.state.orders.get(id)).find(value => value.parentId === position.id && value.exitLevelId === 'position-first' && value.type === OrderType.Limit);
      const request = {context: f.session.commands.context(child.id), order: {...child, limitPrice: 105, qty: 1}};
      const lease = await f.session.commands.preview(request);
      const before = f.simulation.controls.calls().length;
      const result = await f.session.commands.modify({...request, previewToken: lease.token, confirmId: lease.preview.confirmId});
      assert.equal(result.outcome, 'confirmed');
      const calls = f.simulation.controls.calls().slice(before);
      assert.equal(calls.filter(value => value.method === 'modifyOrder').length, 0);
      const method = individual ? 'editIndividualPositionBrackets' : 'editPositionBrackets';
      const mutations = calls.filter(value => value.method === method);
      assert.equal(mutations.length, 1); assert.equal(mutations[0].args[0], position.id);
      assert.equal(mutations[0].args[1].exitLevels[0].takeProfit, 105);
      assert.equal(mutations[0].args[1].exitLevels[0].qty, 1);
      assert.equal(mutations[0].args[1].exitLevels[1].qty, 1);
      assert.equal(store.get(position.id).qty, 4);
    } finally { f.releaseQuotes(); f.session.destroy(); }
  });
}

for (const individual of [false, true]) {
  test(`B05: invalid ${individual ? 'individual' : 'net'} position exits never reach the broker`, async () => {
    const f = await fixture(false, undefined, {}, individual ? 'fx-netting' : 'equity-net');
    try {
      const store = individual ? f.session.state.individualPositions : f.session.state.positions;
      const position = store.get(store.ids()[0]);
      const entry = position.avgPrice ?? position.price;
      const method = individual ? 'editIndividualPositionBrackets' : 'editPositionBrackets';
      const count = () => f.simulation.controls.calls().filter(call => call.method === method).length;
      const before = count();
      for (const brackets of [{ takeProfit: entry - position.side }, { stopLoss: entry + position.side }, { exitLevels: [{ id: 'bad', qty: position.qty, takeProfit: entry - position.side, stopLoss: entry - position.side }] }]) {
        await assert.rejects(f.session.commands.editProtection({ context: f.session.commands.context(position.id, individual ? 'individualPosition' : 'position'), id: position.id, individual, brackets }), { code: 'invalid-input' });
        assert.equal(count(), before);
      }
    } finally { f.releaseQuotes(); f.session.destroy(); }
  });
}
test('position exits are measured from the closing quote, with entry as the fallback', async () => {
  const { positionProtectionReference } = await loadModule('src/core/financial-rules.ts');
  const quotes = { bid: 101, ask: 101.2, trade: 101.1 };
  assert.equal(positionProtectionReference({ side: Side.Buy, avgPrice: 99 }, quotes), 101, 'a long closes at the bid');
  assert.equal(positionProtectionReference({ side: Side.Sell, avgPrice: 99 }, quotes), 101.2, 'a short closes at the ask');
  assert.equal(positionProtectionReference({ side: Side.Buy, avgPrice: 99 }, undefined), 99);
  assert.equal(positionProtectionReference({ side: Side.Buy, price: 98 }, {}), 98, 'an individual position falls back to its fill');
  assert.match(protectionDirectionError({ stopLoss: 102 }, Side.Buy, 101, 'current price'), /below the current price/);
});

for (const individual of [false, true]) {
  test(`B05: ${individual ? 'individual' : 'net'} position stops can trail past entry while staying behind the current price`, async () => {
    const f = await fixture(false, undefined, {}, individual ? 'fx-netting' : 'equity-net');
    try {
      const store = individual ? f.session.state.individualPositions : f.session.state.positions;
      const position = store.get(store.ids()[0]);
      const entry = position.avgPrice ?? position.price;
      const quote = f.session.state.quotes.get(position.symbol);
      const close = position.side === Side.Buy ? quote.bid : quote.ask;
      assert((close - entry) * position.side > 0, 'the fixture position is in profit');
      const context = () => f.session.commands.context(position.id, individual ? 'individualPosition' : 'position');
      const breakeven = Number(((entry + close) / 2).toFixed(2));
      await f.session.commands.editProtection({ context: context(), id: position.id, individual, brackets: { stopLoss: breakeven } });
      const latest = store.get(position.id);
      assert.equal(latest.stopLoss, breakeven, 'a profit-locking stop past the entry is accepted');
      const beyond = close + position.side;
      await assert.rejects(
        f.session.commands.editProtection({ context: f.session.commands.context(position.id, individual ? 'individualPosition' : 'position'), id: position.id, individual, brackets: { stopLoss: beyond } }),
        error => error.code === 'invalid-input' && /current price/.test(error.message),
      );
    } finally { f.releaseQuotes(); f.session.destroy(); }
  });
}

test('B04/A04: called-child and parent edits reserve the same parent while a broker acknowledgement is pending', async () => {
  const pending = deferred(); let entered = false;
  const f = await fixture(false, broker => { const original = broker.modifyOrder; broker.modifyOrder = async (...args) => { entered = true; await pending.promise; return original.apply(broker, args); }; }, {supportModifyOrderPreview: false});
  let first;
  try {
    const child = f.child(OrderType.Limit);
    first = f.session.commands.modify({context: f.session.commands.context(child.id), order: {...child, limitPrice: 103}});
    for (let attempt = 0; !entered && attempt < 20; attempt++) await flush();
    assert.equal(entered, true);
    await assert.rejects(f.session.commands.modify({context: f.session.commands.context(f.parent.id), order: {...f.parent, limitPrice: 100.5}}), {code: 'operation-pending'});
    pending.resolve(); assert.equal((await first).outcome, 'confirmed');
    assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 1);
  } finally { pending.resolve(); await first?.catch(() => {}); f.releaseQuotes(); f.session.destroy(); }
});

for (const called of [false, true]) for (const stopType of [StopType.GuaranteedStop, StopType.TrailingStop]) {
  test(`B05/U04: legacy child stop style ${stopType} retains its discriminator through preview and route ${called}`, async () => {
    const f = await fixture(called, undefined, {}, 'equity-net', {takeProfit: 102, stopLoss: 99});
    try {
      const child = f.child(OrderType.Stop, 'single');
      const order = {...child, stopType, ...(stopType === StopType.TrailingStop ? {trailingStopPips: 50} : {stopPrice: 98})};
      const request = {context: f.session.commands.context(child.id), order};
      const lease = await f.session.commands.preview(request);
      const result = await f.session.commands.modify({...request, previewToken: lease.token, confirmId: lease.preview.confirmId});
      assert.equal(result.outcome, 'confirmed');
      const sent = f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').at(-1).args[0];
      assert.equal(sent.stopType, stopType);
      if (!called) {
        assert.equal(sent.stopLoss, undefined); assert.equal(sent.takeProfit, 102);
        assert.equal(sent[stopType === StopType.TrailingStop ? 'trailingStopPips' : 'guaranteedStop'], stopType === StopType.TrailingStop ? 50 : 98);
      }
    } finally { f.releaseQuotes(); f.session.destroy(); }
  });
}

test('B04: an inactive bracket validates against its parent entry, even when the market is beyond that stop', async () => {
  const f = await fixture();
  try {
    const old = f.child(OrderType.Stop);
    const parent = {...f.parent, side: Side.Sell, limitPrice: 90, exitLevels: [{id: 'first', qty: 2, takeProfit: 80, stopLoss: 95}, {id: 'second', qty: 1, takeProfit: 70, stopLoss: 96}]};
    const child = {...old, side: Side.Buy, stopPrice: 95};
    f.host.orderUpdate(parent); f.host.orderUpdate(child);
    for (const [level, price] of [['first', 80], ['second', 70]]) f.host.orderUpdate({...f.child(OrderType.Limit, level), side: Side.Buy, limitPrice: price});
    f.host.orderUpdate({...f.child(OrderType.Stop, 'second'), side: Side.Buy, stopPrice: 96});
    await f.session.commands.validate({context: f.session.commands.context(child.id), order: {...child, stopPrice: 94}});
    assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 0);
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B04: routing never silently discards unsupported non-financial child edits', async () => {
  const f = await fixture();
  try {
    const child = f.child(OrderType.Limit);
    for (const patch of [{customFields: {new: 'value'}}, {duration: {type: 'GTC'}}, {takeProfit: 104}])
      await assert.rejects(f.session.commands.validate({context: f.session.commands.context(child.id), order: {...child, limitPrice: 103, ...patch}}), {code: 'unsupported'});
  } finally { f.releaseQuotes(); f.session.destroy(); }
});

test('B04/A04: a position child changed by a reentrant publication cannot reach its protection API', async () => {
  for (const individual of [false, true]) {
    const f = await fixture(false, undefined, {}, individual ? 'fx-netting' : 'equity-net');
    let release;
    try {
      const store = individual ? f.session.state.individualPositions : f.session.state.positions;
      const position = store.get(store.ids()[0]);
      await f.session.commands.editProtection({context: f.session.commands.context(position.id, individual ? 'individualPosition' : 'position'), id: position.id, individual, brackets: {takeProfit: 103, stopLoss: 98}});
      const child = f.session.state.orders.ids().map(id => f.session.state.orders.get(id)).find(value => value.parentId === position.id && value.type === OrderType.Limit);
      const request = {context: f.session.commands.context(child.id), order: {...child, limitPrice: 104}};
      const lease = await f.session.commands.preview(request);
      const before = f.simulation.controls.calls().length;
      let changed = false;
      release = f.session.pending.subscribeChanges(() => { if (!changed) { changed = true; f.host.orderUpdate({...child, last: 101}); } });
      await assert.rejects(f.session.commands.modify({...request, previewToken: lease.token, confirmId: lease.preview.confirmId}), {code: 'stale-context'});
      assert.equal(f.simulation.controls.calls().slice(before).filter(value => ['modifyOrder', 'editPositionBrackets', 'editIndividualPositionBrackets'].includes(value.method)).length, 0);
    } finally { release?.(); f.releaseQuotes(); f.session.destroy(); }
  }
});
test('B04: an orphan cannot be modified but can still be cancelled through the broker', async () => {
  let child, cancellations = 0;
  const f = await fixture(false, (broker, host) => { broker.cancelOrder = async id => { assert.equal(id, child.id); cancellations++; host.orderUpdate({...child, status: OrderStatus.Canceled}); }; });
  try {
    child = f.child(OrderType.Limit);
    f.host.orderUpdate({...f.parent, status: OrderStatus.Filled});
    await assert.rejects(f.session.commands.validate({context: f.session.commands.context(child.id), order: {...child, limitPrice: 103}}), {code: 'stale-context'});
    const result = await f.session.commands.cancel({context: f.session.commands.context(child.id), id: child.id});
    assert.equal(result.outcome, 'confirmed'); assert.equal(cancellations, 1);
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B05/A04: a trailing child confirms its distance edit while the broker advances the live trailing price', async () => {
  const f = await fixture(true, (broker, host) => {
    // The broker advances the live trailing price in the same update that reports the new distance,
    // whenever that update arrives relative to the modifyOrder promise.
    const push = host.orderUpdate.bind(host);
    host.orderUpdate = (order) =>
      push(order.stopType === StopType.TrailingStop && order.trailingStopPips === 55 ? { ...order, stopPrice: order.stopPrice + 0.37 } : order);
  }, {}, 'equity-net', {takeProfit: 102, trailingStopPips: 40});
  try {
    const child = f.child(OrderType.Stop, 'single');
    assert.equal(child.stopType, StopType.TrailingStop);
    const order = {...child, trailingStopPips: 55};
    const request = {context: f.session.commands.context(child.id), order};
    const lease = await f.session.commands.preview(request);
    const result = await f.session.commands.modify({...request, previewToken: lease.token, confirmId: lease.preview.confirmId});
    assert.equal(result.outcome, 'confirmed');
    const current = f.session.state.orders.get(child.id);
    assert.equal(current.trailingStopPips, 55);
    assert.equal(current.stopPrice, child.stopPrice + 0.37, 'broker-reported trailing price is retained, not overwritten');
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B04: a TP edit keeps the SL leg that the parent omitted but an active child still proves', async () => {
  const f = await fixture(false, undefined, {}, 'equity-net', {takeProfit: 102, stopLoss: 99});
  try {
    const { stopLoss, ...partial } = f.session.state.orders.get(f.parent.id);
    assert.equal(stopLoss, 99);
    f.host.orderUpdate(partial);
    const child = f.child(OrderType.Limit, 'single');
    const request = {context: f.session.commands.context(child.id), order: {...child, limitPrice: 103}};
    const lease = await f.session.commands.preview(request);
    await f.session.commands.modify({...request, previewToken: lease.token, confirmId: lease.preview.confirmId});
    const sent = f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').at(-1).args[0];
    assert.equal(sent.takeProfit, 103);
    assert.equal(sent.stopLoss, 99, 'the stop leg is not silently cancelled');
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
test('B06: a submitted child whose parent fields no longer fit its parent is rejected before any broker call', async () => {
  const f = await fixture(false, undefined, { supportModifyOrderPreview: false });
  try {
    const child = f.child(OrderType.Limit);
    const context = f.session.commands.context(child.id);
    await assert.rejects(f.session.commands.modify({ context, order: { ...child, limitPrice: 103, parentId: 'someone-else' } }), /identity/);
    // Parent ID and side are order identity: the identity rule refuses both before routing reads the stored order.
    await assert.rejects(f.session.commands.modify({ context, order: { ...child, side: -child.side } }), /identity/);
    assert.equal(f.simulation.controls.calls().filter(value => value.method === 'modifyOrder').length, 0);
  } finally { f.releaseQuotes(); f.session.destroy(); }
});
