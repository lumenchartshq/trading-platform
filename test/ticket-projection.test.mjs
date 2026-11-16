import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';
const { createTicketProjection } = await loadModule('src/ui/order-ticket/chart-projection.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
const { OrderType } = await loadModule('src/contracts/broker.ts');
function fixture() {
  let binding = { id: 'C', generation: 1, symbol: 'X' };
  const state = new ValueStore({ binding, phase: 'editing', revision: 1, order: { symbol: 'X', side: 1, type: 1, qty: 2, limitPrice: 100 }, instrument: { minTick: 0.01, pipSize: 0.01, pipValue: 0.01, qty: { min: 1, max: 100, step: 1 } } });
  const noop = () => () => {};
  const overlays = [];
  const chart = { binding: { get: () => binding }, createOverlay(spec) {
    let listener;
    const line = { spec, removed: false, update(patch) { line.spec = { ...line.spec, ...patch }; }, subscribe(next) { listener = next; line.emitLate = next; return () => { listener = undefined; }; }, cancelInteraction() { line.cancelled = true; listener?.({ type: 'dragCancel', gestureId: 'G', price: 100 }); }, remove() { line.removed = true; }, emit(event) { listener?.(event); } };
    overlays.push(line); return line;
  } };
  let changed, quoteChanged, reads = 0;
  const collection = { charts: () => { reads++; return [chart]; }, subscribe: next => { changed = next; return () => {}; } };
  const patch = changes => { const previous = state.get(); state.set({ ...previous, order: { ...previous.order, ...changes }, revision: previous.revision + 1 }); };
  const controller = { state, patch, patchProtection: patch, close: () => state.set({ ...state.get(), phase: 'closed' }) };
  const session = { state: { quotes: { get: () => ({ bid: 100, ask: 100.01 }), subscribeChanges: listener => { quoteChanged = listener; return () => {}; } }, pipValues: { get: () => undefined, subscribeChanges: noop } }, policy: { subscribe: noop }, symbolPolicy: () => ({ flags: { supportOrderBrackets: true, supportMarketBrackets: true }, orderTypes: [1, 2, 3] }), displaySettings: { get: () => ({ showPositionProfit: false, positionProfitDisplay: 'money' }), subscribe: noop } };
  const projection = createTicketProjection(session, collection, controller);
  return { state, patch, overlays, projection, controller, reads: () => reads, quote: symbol => quoteChanged({ added: [], updated: [symbol], removed: [] }), rebind() { binding = { ...binding, generation: 2 }; changed({ type: 'bindingChanged' }); } };
}
test('OC06/OC12: unsent projection shares canonical quantity and legs; cancel restores the draft without broker entities', () => {
  const f = fixture(), parent = f.overlays[0];
  f.patch({ qty: 3 }); assert.equal(parent.spec.quantity, 3);
  parent.emit({ type: 'dragStart', gestureId: 'G', price: 100, leg: 'takeProfit' });
  parent.emit({ type: 'dragPreview', gestureId: 'G', price: 110, leg: 'takeProfit' });
  assert.equal(f.state.get().order.takeProfit, 110);
  assert.equal(f.overlays.filter(line => !line.removed).length, 1);
  assert.equal(parent.spec.protection.preview.text, "—");
  assert.deepEqual(parent.spec.protection.handles, ["takeProfit", "stopLoss"], 'active leg remains eligible until gesture completion; native preview hides its entry handle');
  parent.emit({ type: 'dragCancel', gestureId: 'G', price: 110, leg: 'takeProfit' });
  assert.equal(f.state.get().order.takeProfit, undefined);
  assert.equal(f.overlays.filter(line => !line.removed).length, 1);
  f.controller.close(); assert(f.overlays.every(line => line.removed));
  f.projection.destroy();
});
test('OC06/OC08: chart drags set an executable tick price in the Market ticket', () => {
  const f = fixture();
  try {
    f.patch({ type: OrderType.Market });
    const parent = f.overlays[0];
    parent.emit({ type: 'dragStart', gestureId: 'G', price: 100.01, leg: 'stopLoss' });
    parent.emit({ type: 'dragPreview', gestureId: 'G', price: 94.293, leg: 'stopLoss' });
    parent.emit({ type: 'dragCommit', gestureId: 'G', price: 94.293, leg: 'stopLoss' });
    assert.equal(f.state.get().order.stopLoss, 94.29);
    const stop = f.overlays.find(line => line.spec.key === 'projected-order:root:stopLoss');
    assert.equal(stop.spec.price, 94.29);
    stop.emit({ type: 'dragStart', gestureId: 'G', price: 94.29 });
    stop.emit({ type: 'dragPreview', gestureId: 'G', price: 93.297 });
    stop.emit({ type: 'dragCommit', gestureId: 'G', price: 93.297 });
    assert.equal(f.state.get().order.stopLoss, 93.3);
    assert.equal(stop.spec.price, 93.3);
  } finally { f.projection.destroy(); }
});

test('OC06: changing a Market draft side replaces the side-bound chart line', () => {
  const f = fixture();
  try {
    f.patch({ type: OrderType.Market });
    const buy = f.overlays[0];
    assert.equal(buy.spec.label, 'Market');
    f.patch({ side: -1 });
    assert.equal(buy.removed, true);
    const sell = f.overlays.find(line => !line.removed);
    assert.equal(sell.spec.side, -1);
    assert.equal(sell.spec.label, 'Market');
  } finally { f.projection.destroy(); }
});

test('OC09/OC10: external edits and binding changes fence old projection gestures', () => {
  const f = fixture(), parent = f.overlays[0];
  parent.emit({ type: 'dragStart', gestureId: 'G', price: 100 });
  f.patch({ qty: 7 });
  parent.emit({ type: 'dragPreview', gestureId: 'G', price: 90 });
  assert.equal(f.state.get().order.qty, 7); assert.equal(f.state.get().order.limitPrice, 100);
  assert(parent.cancelled);
  f.rebind(); assert(parent.removed);
  f.projection.destroy();
});
test('OC08/OC09: external draft changes cancel the active exit or stop-trigger source rather than the entry', () => {
  for (const changes of [{ takeProfit: 110 }, { type: 4, stopPrice: 105 }]) {
    const f = fixture();
    try {
      f.patch(changes);
      const child = f.overlays.find(line => line !== f.overlays[0] && !line.removed);
      child.emit({ type: 'dragStart', gestureId: 'G', price: child.spec.price });
      child.emit({ type: 'dragPreview', gestureId: 'G', price: child.spec.price + 1 });
      f.patch({ qty: 7 });
      assert(child.cancelled, 'the source holding physical capture must be cancelled');
      assert.equal(f.overlays[0].cancelled, undefined, 'an idle entry line owns no child gesture');
      const price = f.state.get().order.stopPrice ?? f.state.get().order.takeProfit;
      child.emit({ type: 'dragPreview', gestureId: 'G', price: 999 });
      assert.equal(f.state.get().order.stopPrice ?? f.state.get().order.takeProfit, price);
    } finally { f.projection.destroy(); }
  }
});
test('OC09/OC12: malformed draft callbacks cancel their gesture without reading accessors or changing the draft', () => {
  const f = fixture(), parent = f.overlays[0];
  try {
    parent.emit({ type: 'dragStart', gestureId: 'G', price: 100 });
    parent.emit({ type: 'dragPreview', gestureId: 'G', price: 105 });
    assert.equal(f.state.get().order.limitPrice, 105);
    let reads = 0;
    parent.emit({ type: 'dragPreview', gestureId: 'G', get price() { reads++; return 999; } });
    assert.equal(reads, 0);
    assert(parent.cancelled);
    assert.equal(f.state.get().order.limitPrice, 100, 'cancelling malformed input restores the drag-start draft');
    parent.emit({ type: 'dragPreview', gestureId: 'G', price: 999 });
    parent.emit({ type: 'dragCommit', gestureId: 'G', price: 999 });
    assert.equal(f.state.get().order.limitPrice, 100);
  } finally { f.projection.destroy(); }
});
test('OC09/OC12: entering review releases exit capture and retired sources cannot close a replacement draft', () => {
  const f = fixture();
  try {
    f.patch({ takeProfit: 110 });
    const child = f.overlays.find(line => line !== f.overlays[0] && !line.removed);
    child.emit({ type: 'dragStart', gestureId: 'G', price: 110 });
    f.state.set({ ...f.state.get(), phase: 'confirming' });
    assert(child.cancelled);
    const retired = f.overlays[0];
    f.controller.close();
    f.state.set({ ...f.state.get(), phase: 'editing', revision: f.state.get().revision + 1 });
    retired.emitLate({ type: 'cancel' });
    assert.equal(f.state.get().phase, 'editing');
  } finally { f.projection.destroy(); }
});
test('OC08: allocated draft legs retain level IDs, siblings and quantities', () => {
  const f = fixture();
  f.patch({ exitLevels: [{ id: 'a', qty: 1, takeProfit: 110, stopLoss: 90 }, { id: 'b', qty: 1, takeProfit: 115, stopLoss: 85 }] });
  const leg = f.overlays.find(line => line.spec.key === 'projected-order:a:takeProfit');
  assert.equal(leg.spec.quantity, 1);
  leg.emit({ type: 'dragStart', gestureId: 'G', price: 110 });
  leg.emit({ type: 'dragPreview', gestureId: 'G', price: 112 });
  leg.emit({ type: 'dragCommit', gestureId: 'G', price: 112 });
  assert.deepEqual(f.state.get().order.exitLevels, [{ id: 'a', qty: 1, takeProfit: 112, stopLoss: 90 }, { id: 'b', qty: 1, takeProfit: 115, stopLoss: 85 }]);
  leg.emit({ type: 'cancel' });
  assert.deepEqual(f.state.get().order.exitLevels.map(level => level.id), ['b']);
  f.projection.destroy();
});
test('OC06: submitted drafts cannot be edited through retained chart callbacks', () => {
  const f = fixture(), parent = f.overlays[0];
  f.state.set({ ...f.state.get(), phase: 'sending' });
  parent.emit({ type: 'dragStart', gestureId: 'G', price: 100 });
  parent.emit({ type: 'dragPreview', gestureId: 'G', price: 95 });
  parent.emit({ type: 'cancel' });
  assert.equal(f.state.get().order.limitPrice, 100);
  assert.equal(f.state.get().phase, 'sending');
  f.projection.destroy();
});
test('OC08: Stop Limit draft trigger moves independently of its limit price', () => {
  const f = fixture();
  f.patch({ type: 4, stopPrice: 105 });
  const trigger = f.overlays.find(line => line.spec.key === 'projected-order:trigger');
  assert(trigger);
  trigger.emit({ type: 'dragStart', gestureId: 'G', price: 105 });
  trigger.emit({ type: 'dragPreview', gestureId: 'G', price: 106 });
  trigger.emit({ type: 'dragCommit', gestureId: 'G', price: 106 });
  assert.equal(f.state.get().order.stopPrice, 106);
  assert.equal(f.state.get().order.limitPrice, 100);
  f.projection.destroy();
});

test('OC12: unrelated quotes and closed drafts do no projection reconciliation', () => {
  const f = fixture(), before = f.reads();
  for (let i = 0; i < 1000; i++) f.quote('OTHER');
  assert.equal(f.reads(), before);
  f.quote('X'); assert.equal(f.reads(), before + 1);
  f.controller.close();
  const closed = f.reads(); f.quote('X'); assert.equal(f.reads(), closed);
  f.projection.destroy();
});

test('OC08/OC09: moving an existing draft exit keeps its source attached throughout the gesture', () => {
  const f = fixture(); f.patch({ takeProfit: 110 });
  const child = f.overlays.find(line => line.spec.key === 'projected-order:root:takeProfit');
  child.emit({ type: 'dragStart', gestureId: 'G', price: 110 });
  child.emit({ type: 'dragPreview', gestureId: 'G', price: 112 });
  assert.equal(child.removed, false);
  assert.equal(f.state.get().order.takeProfit, 112);
  child.emit({ type: 'dragCommit', gestureId: 'G', price: 112 });
  assert.equal(child.removed, false);
  assert.equal(child.spec.protection.preview.price, 112);
  assert.deepEqual(f.overlays[0].spec.protection.handles, ['stopLoss']);
  f.projection.destroy();
});

test('OC06/OC08: pure ticket projection labels, phases and hides the dragged leg without a session', async () => {
  const { projectTicketOverlays } = await loadModule('src/chart/ticket-projection.ts');
  const input = overrides => ({
    order: { symbol: 'X', side: 1, type: 4, qty: 2, limitPrice: 100, stopPrice: 101, takeProfit: 110, stopLoss: 90 },
    entry: 100, editable: true, pending: false, flags: { supportOrderBrackets: true, supportMarketBrackets: true },
    profitText: exit => `${exit - 100}`, ...overrides,
  });
  const draft = projectTicketOverlays(input());
  assert.equal(draft.entry.label, 'Stop-limit');
  assert.deepEqual(draft.entry.protection.handles, []);
  assert.deepEqual(draft.lines.map(line => [line.key, line.spec.label, line.spec.side]), [
    ['trigger', 'Stop trigger', 1],
    ['root:takeProfit', 'Take Profit · 10', -1],
    ['root:stopLoss', 'Stop Loss · -10', -1],
  ]);
  assert.deepEqual(draft.lines.find(line => line.key === 'trigger').spec.actions, ['modify']);
  const dragging = projectTicketOverlays(input({ activeLeg: 'takeProfit' }));
  assert.deepEqual(dragging.lines.map(line => line.key), ['trigger', 'root:stopLoss']);
  assert.equal(dragging.entry.protection.preview.text, '10');
  const sending = projectTicketOverlays(input({ editable: false, pending: true }));
  assert.equal(sending.entry.protection.phase, 'pending');
  assert(sending.lines.every(line => line.spec.actions.length === 0));
  const market = projectTicketOverlays(input({ order: { symbol: 'X', side: -1, type: 2, qty: 1 }, flags: { supportOrderBrackets: true, supportMarketBrackets: false } }));
  assert.deepEqual(market.entry.protection.handles, [], 'market brackets need broker support');
});
