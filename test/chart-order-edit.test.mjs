import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';
const { createTradingState } = await loadModule('src/core/trading-state.ts');
const { createChartOrderEdit, chartProtectionPatch } = await loadModule('src/core/chart-order-edit.ts');
function fixture() {
  const state = createTradingState();
  state.connection.set({ phase: 'ready', status: 1, accountId: 'A', generation: 1 });
  const order = { id: 'O', symbol: 'X', side: 1, qty: 2, type: 1, status: 6, limitPrice: 100, takeProfit: 110, customFields: { keep: 'yes' } };
  state.orders.upsert(order);
  const edits = createChartOrderEdit(state, (id, kind) => ({ accountId: 'A', generation: 1, revision: state.orders.revision(id) }));
  return { state, edits, order, binding: { id: 'C', generation: 1, symbol: 'X' } };
}
test('OC06/OC08: chart proposals preserve sibling legs, quantity and fields without writing broker state', () => {
  const f = fixture();
  f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' });
  const edit = f.edits.propose(95);
  assert.equal(edit.order.takeProfit, 110); assert.equal(edit.order.stopLoss, 95); assert.equal(edit.order.qty, 2);
  assert.deepEqual(edit.order.customFields, { keep: 'yes' });
  assert.equal(f.state.orders.get('O').stopLoss, undefined);
  f.edits.sync({ ...edit.order, stopLoss: 96 }, 'reviewing');
  assert.equal(f.edits.state.get().order.stopLoss, 96);
  f.edits.clear(); assert.equal(f.edits.state.get(), undefined);
  f.edits.destroy(); f.state.destroy();
});
test('OC09: live entity changes and account switching invalidate a captured edit before confirmation', () => {
  const f = fixture();
  f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' });
  f.state.orders.upsert({ ...f.order, qty: 3 });
  assert.equal(f.edits.state.get(), undefined);
  assert.throws(() => f.edits.propose(95), error => error.code === 'stale-context');
  f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' });
  f.state.connection.set({ phase: 'switching', status: 1, accountId: 'B', generation: 2 });
  assert.equal(f.edits.state.get(), undefined);
  f.edits.destroy(); f.state.destroy();
});
test('OC08: unsupported legacy conversion and stop-style replacement are explicit errors', () => {
  assert.throws(() => chartProtectionPatch({ exitLevels: [{ id: 'L', qty: 1, takeProfit: 110, stopLoss: 90 }] }, 'takeProfit', 111), error => error.code === 'unsupported');
  assert.throws(() => chartProtectionPatch({ guaranteedStop: 90 }, 'stopLoss', 91), error => error.code === 'unsupported');
});

test('OC06: a second leg proposal retains the first unconfirmed leg on the same captured parent', () => {
  const f = fixture();
  f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' }); f.edits.propose(95);
  f.edits.begin('O', 'order', f.binding, { leg: 'takeProfit' });
  const next = f.edits.propose(112);
  assert.equal(next.order.stopLoss, 95); assert.equal(next.order.takeProfit, 112);
  assert.equal(f.state.orders.get('O').stopLoss, undefined);
  f.edits.destroy(); f.state.destroy();
});

test('OC08: chart multiple levels add a paired allocation and retain existing identities and sibling values', async () => {
  const { appendChartExit } = await loadModule('src/core/chart-exit-level.ts');
  const instrument = { minTick: 0.01, qty: { min: 1, max: 100, step: 1 } };
  const parent = { qty: 4, exitLevels: [{ id: 'existing', qty: 4, takeProfit: 110, stopLoss: 90, isExisting: true }] };
  const next = appendChartExit(parent, 'takeProfit', 112, 100, instrument, 'new', 3);
  assert.equal(next.exitLevels[0].id, 'existing'); assert.equal(next.exitLevels[0].takeProfit, 110); assert.equal(next.exitLevels[0].stopLoss, 90);
  assert.equal(next.exitLevels[0].qty, 3);
  assert.deepEqual(next.exitLevels[1], { id: 'new', qty: 1, takeProfit: 112, stopLoss: 88, isExisting: false });
  assert.equal(parent.exitLevels[0].qty, 4);
  assert.throws(() => appendChartExit(parent, 'stopLoss', 95, 100, instrument, 'new', 1), error => error.code === 'invalid-input');
});

test('OC08: moving one leg of an allocated level keeps its identity, quantity and the other levels', async () => {
  const { moveChartExitLevel } = await loadModule('src/core/chart-exit-level.ts');
  const parent = { qty: 4, exitLevels: [
    { id: 'first', qty: 2, takeProfit: 110, stopLoss: 90, isExisting: true },
    { id: 'second', qty: 2, takeProfit: 115, stopLoss: 92, isExisting: true },
  ] };
  const next = moveChartExitLevel(parent, 'second', 'stopLoss', 94);
  assert.deepEqual(next.exitLevels, [
    { id: 'first', qty: 2, takeProfit: 110, stopLoss: 90, isExisting: true },
    { id: 'second', qty: 2, takeProfit: 115, stopLoss: 94, isExisting: true },
  ]);
  assert.equal(parent.exitLevels[1].stopLoss, 92, 'the broker level is not mutated');
  assert.throws(() => moveChartExitLevel(parent, 'gone', 'stopLoss', 94), error => error.code === 'stale-context');
  assert.throws(() => moveChartExitLevel(parent, 'first', 'stopLoss', Number.NaN), error => error.code === 'invalid-input');
  const trailing = { qty: 2, exitLevels: [{ id: 'trail', qty: 2, takeProfit: 110, trailingStopPips: 20 }] };
  assert.throws(() => moveChartExitLevel(trailing, 'trail', 'stopLoss', 94), error => error.code === 'unsupported');
  assert.throws(() => moveChartExitLevel({ qty: 2, exitLevels: [{ id: 'tp-only', qty: 2, takeProfit: 110 }] }, 'tp-only', 'stopLoss', 94), error => error.code === 'unsupported');
});

test('OC04: clearIf ends only the proposal that started an action, and a settled ticket ends it', () => {
  const f = fixture();
  const first = f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' });
  f.edits.clearIf(first.token + 1); assert.equal(f.edits.state.get()?.token, first.token, 'a stale token leaves the newer proposal');
  f.edits.clearIf(undefined); assert.equal(f.edits.state.get()?.token, first.token);
  const proposed = f.edits.propose(95);
  f.edits.sync({ ...proposed.order }, 'sending'); assert.equal(f.edits.state.get().phase, 'sending');
  f.edits.sync({ ...proposed.order }, undefined); assert.equal(f.edits.state.get(), undefined);
  f.edits.begin('O', 'order', f.binding, { leg: 'stopLoss' });
  f.edits.clearIf(f.edits.state.get().token); assert.equal(f.edits.state.get(), undefined);
  f.edits.destroy(); f.state.destroy();
});
