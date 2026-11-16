import { simulatedSession } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createDomController } = await loadModule('src/ui/dom/controller.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
async function fixture(options = {}) {
  const { session, simulation } = await simulatedSession({
    flags: { supportLevel2Data: true },
    options: { enabledFeatures: ['dom_widget'], ...options },
  });
  const binding = new ValueStore({ id: 'chart', generation: 1, symbol: 'SIM:X' });
  const chart = { binding };
  const controller = createDomController(session, chart);
  return { session, simulation, binding, controller, destroy() { controller.destroy(); session.destroy(); } };
}
test('D03: depth limit row opens the shared ticket with captured quantity and price', async () => {
  const f = await fixture();
  try {
    await f.controller.ready; await flush();
    f.controller.quantity(2);
    const key = f.controller.ladder.viewport.get().find(key => f.controller.ladder.row(key).get().price === 99.99);
    const action = f.controller.order(1, key); await flush();
    const entry = f.session.dialogs.current.get();
    assert.equal(entry.request.kind, 'order');
    assert.deepEqual(entry.request.order, { symbol: 'SIM:X', side: 1, type: 1, qty: 2, limitPrice: 99.99 });
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 0);
    await assert.rejects(f.controller.order(1, key), error => error.code === 'operation-pending');
    f.session.dialogs.respond(entry.id, false); await action;
    assert.equal(f.controller.state.get().pending, false);
  } finally { f.destroy(); }
});
test('D03: cancel-side reserves only matching symbol and side and sends one bulk command', async () => {
  const f = await fixture();
  try {
    await f.controller.ready;
    const order = { symbol: 'SIM:X', side: 1, type: 1, qty: 1, status: 6, limitPrice: 99 };
    f.session.host.orderUpdate({ ...order, id: 'buy' });
    f.session.host.orderUpdate({ ...order, id: 'sell', side: -1 });
    const cancel = f.controller.cancel(1); await flush();
    const dialog = f.session.dialogs.current.get();
    f.session.dialogs.respond(dialog.id, true);
    // Injected IDs are not mock broker entities; broker acceptance cannot fabricate success.
    await flush(); f.simulation.clock.advance(10000);
    await assert.rejects(cancel, /could not be confirmed/);
    const calls = f.simulation.controls.calls().filter(call => call.method === 'cancelOrders');
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].args[2], ['buy']);
    assert.equal(f.session.state.orders.get('sell').status, 6);
  } finally { f.destroy(); }
});
test('D03: unavailable depth capability and stale chart bindings never dispatch', async () => {
  const disabled = await fixture({ disabledFeatures: ['dom_widget'] });
  await assert.rejects(disabled.controller.ready, /unavailable/);
  await assert.rejects(disabled.controller.order(1), /unavailable/);
  disabled.destroy();
  const f = await fixture();
  try {
    await f.controller.ready;
    f.binding.set({ id: 'chart', generation: 2, symbol: 'OTHER' });
    await assert.rejects(f.controller.order(1), error => error.code === 'stale-context');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 0);
  } finally { f.destroy(); }
});


test('D03/A05: closing a depth controller while cancellation is awaiting approval cannot dispatch', async () => {
  const f = await fixture();
  try {
    await f.controller.ready;
    f.session.host.orderUpdate({ id: 'pending', symbol: 'SIM:X', side: 1, type: 1, qty: 1, status: 6, limitPrice: 99 });
    const cancellation = f.controller.cancel(1); await flush();
    const entry = f.session.dialogs.current.get(); assert.equal(entry.request.kind, 'confirm');
    f.controller.destroy();
    assert.equal(f.simulation.controls.subscriptionCounts().depth, 0);
    f.session.dialogs.respond(entry.id, true);
    await assert.rejects(cancellation, error => error.code === 'disposed');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'cancelOrders').length, 0);
  } finally { f.destroy(); }
});
test('D03/O02: broker rejection of depth cancel-all and reverse reports an error, keeps broker state and allows a retry', async () => {
  const f = await fixture();
  try {
    await f.controller.ready;
    const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: 'SIM:X', side: 1, type: 1, qty: 1, limitPrice: 99 } });
    const id = placed.entityIds[0];
    f.simulation.controls.rejectNextOperation('Exchange closed');
    const cancel = f.controller.cancel(); await flush();
    f.session.dialogs.respond(f.session.dialogs.current.get().id, true);
    await assert.rejects(cancel);
    assert.equal(f.session.state.orders.get(id).status, 6, 'the order stays working; no fake cancellation');
    assert.equal(f.controller.state.get().pending, false);
    assert(f.controller.state.get().error, 'the rejection is visible');
    const positionId = f.session.state.positions.ids()[0], side = f.session.state.positions.get(positionId).side;
    f.simulation.controls.rejectNextOperation('Reverse unavailable');
    const reverse = f.controller.reverse(positionId); await flush();
    f.session.dialogs.respond(f.session.dialogs.current.get().id, true);
    await assert.rejects(reverse);
    assert.equal(f.session.state.positions.get(positionId).side, side);
    const retry = f.controller.cancel(); await flush();
    await assert.rejects(f.controller.cancel(), /Wait for the current action/, 'a second depth action cannot start while one is pending');
    f.session.dialogs.respond(f.session.dialogs.current.get().id, true);
    await retry;
    assert.equal(f.session.state.orders.get(id).status, 1, 'the retry cancels through the broker');
  } finally { f.destroy(); }
});
