import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { routeModification, existingOrderId } = await loadModule('src/core/modification-routing.ts');
const { createTradingState } = await loadModule('src/core/trading-state.ts');
const { captureModificationParent } = await loadModule('src/core/modification-context.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const { OrderStatus, OrderType, ParentType, Side } = await loadModule('src/contracts/broker.ts');

const instrument = { description: 'X', minTick: 0.01, pipSize: 0.01, pipValue: 1, qty: { min: 1, max: 100, step: 1 } };
const policy = resolveCapabilities({ configFlags: { supportOrderBrackets: true, supportPositionBrackets: true, supportPositions: true, supportModifyBrackets: true, supportModifyOrderPrice: true, supportEditAmount: true } });
const entry = { id: 'E', symbol: 'X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 100 };
const route = (state, order, extra = {}) => routeModification({ state, order, parentContext: captureModificationParent(state, order.id ?? ''), policy, instrument, ...extra });

test('U01/B01: a new order or a directly edited order takes the plain route with normalised protection', () => {
  const state = createTradingState();
  assert.equal(existingOrderId({ symbol: 'X' }), undefined);
  assert.equal(route(state, { symbol: 'X', side: Side.Buy, qty: 2, type: OrderType.Limit, limitPrice: 100 }).route, 'plain');
  state.orders.upsert(entry);
  const edited = route(state, { ...entry, limitPrice: 101 });
  assert.equal(edited.route, 'plain'); assert.equal(edited.payload.limitPrice, 101);
});
test('B01/B06: a child exit of a parent order modifies the parent unless the called order is passed through', () => {
  const state = createTradingState();
  state.orders.upsert(entry);
  const tp = { id: 'TP', symbol: 'X', side: Side.Sell, qty: 2, type: OrderType.Limit, status: OrderStatus.Inactive, limitPrice: 110, parentId: 'E', parentType: ParentType.Order };
  state.orders.upsert(tp);
  const routed = route(state, { ...tp, limitPrice: 112 });
  assert.equal(routed.route, 'order'); assert.equal(routed.parent.id, 'E');
  assert.equal(routed.payload.id, 'E'); assert.equal(routed.payload.takeProfit, 112);
  const passed = route(state, { ...tp, limitPrice: 112 }, { passCalledOrder: true });
  assert.equal(passed.route, 'order'); assert.equal(passed.payload.id, 'TP');
});
test('B01/C03: a child exit of a position routes to the position with the requested brackets and checks direction', () => {
  const state = createTradingState();
  state.positions.upsert({ id: 'P', symbol: 'X', side: Side.Buy, qty: 2, avgPrice: 100 });
  const tp = { id: 'PTP', symbol: 'X', side: Side.Sell, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 110, parentId: 'P', parentType: ParentType.Position };
  state.orders.upsert(tp);
  const routed = route(state, { ...tp, limitPrice: 115 });
  assert.equal(routed.route, 'position'); assert.equal(routed.parent.kind, 'position');
  assert.equal(routed.brackets.takeProfit, 115); assert.equal(routed.payload.id, 'PTP');
  assert.throws(() => route(state, { ...tp, limitPrice: 90 }), error => error.code === 'invalid-input');
});
