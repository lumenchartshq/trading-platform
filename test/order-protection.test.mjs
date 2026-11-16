import { simulatedSession } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred, flush } from './manual-clock.mjs';
const { StopType } = await loadModule('src/contracts/broker.ts');
const { prepareOrderProtection } = await loadModule('src/core/order-protection.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const instrument = { description: 'Stock', type: 'stock', minTick: 0.01, pipValue: 1, pipSize: 0.01, qty: { min: 1, max: 100, step: 1 } };
const order = { symbol: 'SIM:X', side: 1, type: 1, qty: 2, limitPrice: 100, takeProfit: 110, stopLoss: 90 };
async function fixture(flags = {}, configure) {
  return simulatedSession({ flags, configureBroker: configure });
}
test('B01/B04/U01: disabled order, market and crypto bracket capabilities never dispatch', async () => {
  for (const [flags, submitted] of [
    [{ supportOrderBrackets: false }, order],
    [{ supportMarketBrackets: false }, { ...order, type: 2 }],
    [{ supportCryptoExchangeOrderTicket: true, supportCryptoBrackets: false }, order],
  ]) {
    const f = await fixture(flags);
    try {
      await assert.rejects(f.session.commands.place({ context: f.session.commands.context(), order: submitted }), error => error.code === 'unsupported');
      assert.equal(f.simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 0);
    } finally { f.session.destroy(); }
  }
});
test('B04/U04: single-level preview and submission use the same legacy payload without changing parent quantity', async () => {
  const f = await fixture({ supportPlaceOrderPreview: true });
  try {
    const submitted = { ...order, takeProfit: undefined, stopLoss: undefined, exitLevels: [{ id: 'one', qty: 2, takeProfit: 110, stopLoss: 90 }] };
    const request = { context: f.session.commands.context(), order: submitted };
    const lease = await f.session.commands.preview(request);
    const result = await f.session.commands.place({ ...request, previewToken: lease.token, confirmId: lease.preview.confirmId });
    assert.equal(result.outcome, 'confirmed');
    const preview = f.simulation.controls.calls().find(call => call.method === 'previewOrder').args[0];
    const dispatched = f.simulation.controls.calls().find(call => call.method === 'placeOrder').args[0];
    assert.deepEqual(preview, dispatched);
    assert.equal(dispatched.qty, 2); assert.equal(dispatched.exitLevels, undefined); assert.equal(dispatched.takeProfit, 110);
    const partial = { ...submitted, exitLevels: [{ ...submitted.exitLevels[0], qty: 1 }] };
    const partialRequest = { context: f.session.commands.context(), order: partial };
    const partialLease = await f.session.commands.preview(partialRequest);
    await f.session.commands.place({ ...partialRequest, previewToken: partialLease.token, confirmId: partialLease.preview.confirmId });
    const partialPayload = f.simulation.controls.calls().filter(call => call.method === 'placeOrder').at(-1).args[0];
    assert.equal(partialPayload.qty, 2);
    assert.deepEqual(partialPayload.exitLevels, partial.exitLevels);
    assert.equal(partialPayload.takeProfit, undefined);
    assert.equal(partialPayload.stopLoss, undefined);
    assert.deepEqual(f.simulation.controls.calls().filter(call => call.method === 'previewOrder').at(-1).args[0], partialPayload);
    // Parent ID is broker-assigned; every child for the partial level retains its one-unit allocation.
    const partialParent = f.simulation.controls.snapshot().orders.findLast(value => value.exitLevels?.[0]?.id === 'one');
    const partialChildren = f.simulation.controls.snapshot().orders.filter(value => value.parentId === partialParent.id);
    assert.equal(partialChildren.length, 2);
    assert(partialChildren.every(value => value.qty === 1));
  } finally { f.session.destroy(); }
});
test('B04: order pair restriction is independent of the position restriction and empty levels are invalid', () => {
  const policy = flags => resolveCapabilities({ configFlags: { supportOrderBrackets: true, supportMultipleExitLevels: true, supportUnpairedExitLevels: true, ...flags } });
  assert.throws(() => prepareOrderProtection({ ...order, stopLoss: undefined }, instrument, policy({ supportOnlyPairOrderBrackets: true })), /together/);
  assert.equal(prepareOrderProtection({ ...order, stopLoss: undefined }, instrument, policy({ supportOnlyPairPositionBrackets: true })).takeProfit, 110);
  assert.throws(() => prepareOrderProtection({ ...order, exitLevels: [{ id: 'empty', qty: 2 }] }, instrument, policy({})), /at least one/);
  assert.throws(() => prepareOrderProtection({ ...order, takeProfit: 99 }, instrument, policy({})), /profit side/);
  assert.throws(() => prepareOrderProtection({ ...order, stopLoss: 101 }, instrument, policy({})), /risk side/);
});
test('B04/U01: existing-order add permission and broker max level count are enforced', async () => {
  const f = await fixture({ supportAddBracketsToExistingOrder: false });
  try {
    const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { ...order, takeProfit: undefined, stopLoss: undefined } });
    const id = placed.entityIds[0];
    await assert.rejects(f.session.commands.modify({ context: f.session.commands.context(id), order: { ...f.session.state.orders.get(id), takeProfit: 110, stopLoss: 90 } }), /cannot be added/);
    const levels = Array.from({ length: 5 }, (_, index) => ({ id: String(index), qty: 1, takeProfit: 110, stopLoss: 90 }));
    await assert.rejects(f.session.commands.place({ context: f.session.commands.context(), order: { ...order, qty: 5, exitLevels: levels } }), /too many/);
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'modifyOrder').length, 0);
  } finally { f.session.destroy(); }
});

test('U04: preview results for a changed order revision are rejected before issuing a token', async () => {
  const pending = deferred(); let host;
  const f = await fixture({ supportModifyOrderPreview: true }, (broker, adapterHost) => { host = adapterHost; broker.previewOrder = () => pending.promise; });
  try {
    const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { ...order, takeProfit: undefined, stopLoss: undefined } });
    const id = placed.entityIds[0], current = f.session.state.orders.get(id);
    const preview = f.session.commands.preview({ context: f.session.commands.context(id), order: current });
    await flush(); host.orderUpdate({ ...current, limitPrice: 99 });
    pending.resolve({ confirmId: 'stale', sections: [] });
    await assert.rejects(preview, error => error.code === 'stale-context');
  } finally { f.session.destroy(); }
});
test('U04/A04: preview snapshots the submitted order before asynchronous metadata reads', async () => {
  let received;
  const f = await fixture({ supportPlaceOrderPreview: true }, broker => { broker.previewOrder = async input => { received = input; return { sections: [] }; }; });
  try {
    const submitted = { symbol: 'SIM:X', type: 1, side: 1, qty: 2, limitPrice: 100 };
    const preview = f.session.commands.preview({ context: f.session.commands.context(), order: submitted });
    submitted.qty = 99; await preview;
    assert.equal(received.qty, 2);
  } finally { f.session.destroy(); }
});


test('B05/U01: symbol bracket edit permission rejects changes and removal before preview or dispatch', async () => {
  const f = await fixture({}, broker => { broker.getSymbolSpecificTradingOptions = async () => ({ supportModifyOrderBrackets: false }); });
  try {
    const placed = await f.session.commands.place({ context: f.session.commands.context(), order });
    const id = placed.entityIds[0], original = f.session.state.orders.get(id);
    for (const patch of [{ stopLoss: 91 }, { stopLoss: undefined, takeProfit: undefined }, { stopLoss: undefined, guaranteedStop: 91 }, { stopLoss: undefined, trailingStopPips: 10 }]) {
      const request = { context: f.session.commands.context(id), order: { ...original, ...patch } };
      await assert.rejects(f.session.commands.preview(request), { code: 'unsupported' });
      await assert.rejects(f.session.commands.modify(request), { code: 'unsupported' });
    }
    assert.equal(f.simulation.controls.calls().filter(call => ['previewOrder', 'modifyOrder'].includes(call.method)).length, 0);
    const result = await f.session.commands.modify({ context: f.session.commands.context(id), order: { ...original, limitPrice: 99 } });
    assert.equal(result.outcome, 'confirmed', 'a locked bracket must not prohibit unrelated permitted price edits');
  } finally { f.session.destroy(); }
});

test('B05/U01: trailing permission applies to style changes before preview and allows an unchanged trailing field', async () => {
  const f = await fixture({ supportModifyTrailingStop: false });
  try {
    const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { ...order, stopLoss: undefined, trailingStopPips: 10, stopType: StopType.TrailingStop } });
    const id = placed.entityIds[0], original = f.session.state.orders.get(id);
    for (const patch of [{ trailingStopPips: 11 }, { stopType: StopType.GuaranteedStop }]) {
      const request = { context: f.session.commands.context(id), order: { ...original, ...patch } };
      await assert.rejects(f.session.commands.preview(request), { code: 'unsupported' });
      await assert.rejects(f.session.commands.modify(request), { code: 'unsupported' });
    }
    assert.equal(f.simulation.controls.calls().filter(call => ['previewOrder', 'modifyOrder'].includes(call.method)).length, 0);
    const result = await f.session.commands.modify({ context: f.session.commands.context(id), order: { ...original, limitPrice: 99 } });
    assert.equal(result.outcome, 'confirmed');
  } finally { f.session.destroy(); }
});

test('B05/A04: bracket permission changes during metadata preparation and reentrant dispatch cannot reach the broker', async () => {
  for (const phase of ['metadata', 'dispatch']) {
    const pending = deferred(); let delay = false, entered = false;
    const f = await fixture({}, broker => {
      broker.getOrderDialogOptions = async () => { if (!delay) return {}; entered = true; return pending.promise; };
    });
    let release;
    try {
      const placed = await f.session.commands.place({ context: f.session.commands.context(), order });
      const id = placed.entityIds[0], original = f.session.state.orders.get(id);
      if (phase === 'metadata') delay = true;
      else release = f.session.pending.subscribeChanges(() => {
        f.session.host.patchConfig({ supportModifyBrackets: false });
      });
      const result = f.session.commands.modify({ context: f.session.commands.context(id), order: { ...original, stopLoss: 91 } });
      const rejected = assert.rejects(result, { code: 'unsupported' });
      if (phase === 'metadata') {
        await flush(); assert.equal(entered, true);
        f.session.host.patchConfig({ supportModifyBrackets: false }); pending.resolve({});
      }
      await rejected;
      assert.equal(f.simulation.controls.calls().filter(call => call.method === 'modifyOrder').length, 0);
    } finally { release?.(); f.session.destroy(); }
  }
});

test('B05/U04: permitted trailing and guaranteed modifications preview and dispatch the same distinct payload', async () => {
  for (const [field, type, initial, changed] of [
    ['trailingStopPips', StopType.TrailingStop, 10, 11],
    ['guaranteedStop', StopType.GuaranteedStop, 90, 91],
  ]) {
    const f = await fixture({ supportModifyOrderPreview: true });
    try {
      const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { ...order, stopLoss: undefined, [field]: initial, stopType: type } });
      const id = placed.entityIds[0], original = f.session.state.orders.get(id);
      const request = { context: f.session.commands.context(id), order: { ...original, [field]: changed } };
      const lease = await f.session.commands.preview(request);
      const result = await f.session.commands.modify({ ...request, previewToken: lease.token, confirmId: lease.preview.confirmId });
      assert.equal(result.outcome, 'confirmed');
      const previews = f.simulation.controls.calls().filter(call => call.method === 'previewOrder');
      const sent = f.simulation.controls.calls().filter(call => call.method === 'modifyOrder');
      assert.equal(previews.length, 1); assert.equal(sent.length, 1);
      assert.deepEqual(previews[0].args[0], sent[0].args[0]);
      assert.equal(sent[0].args[0][field], changed); assert.equal(sent[0].args[0].stopType, type);
      assert.equal(sent[0].args[0].stopLoss, undefined);
    } finally { f.session.destroy(); }
  }
});

test('B04/U04: one protected order preview reads order dialog options once', async () => {
  let reads = 0;
  const f = await fixture({ supportPlaceOrderPreview: true }, broker => {
    broker.getOrderDialogOptions = async () => { reads++; return {}; };
  });
  try {
    await f.session.commands.preview({ context: f.session.commands.context(), order });
    assert.equal(reads, 1);
  } finally { f.session.destroy(); }
});
