import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { createParentLinks } = await loadModule('src/chart/parent-links.ts');
const { createBracketLinks } = await loadModule('src/chart/bracket-links.ts');
const { OrderStatus, OrderType, ParentType, Side } = await loadModule('src/contracts/broker.ts');
const reader = rows => ({ get: id => rows.get(id) });

test('B01/B04: parent links fold child legs into the parent, name allocated levels and measure market parents from the quote', () => {
  const orders = new Map(), positions = new Map(), quotes = new Map([['X', { ask: 101, bid: 100.9 }]]);
  const links = createBracketLinks();
  const keyFor = (kind, id) => `${kind}:${id}`;
  positions.set('P', { id: 'P', symbol: 'X', side: Side.Buy, qty: 2, avgPrice: 100, exitLevels: [{ id: 'L1', qty: 2, takeProfit: 110 }] });
  const tp = { id: 'TP', symbol: 'X', side: Side.Sell, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 110, parentId: 'P', parentType: ParentType.Position, exitLevelId: 'L1' };
  orders.set('TP', tp); links.update('TP', tp);
  const market = { id: 'M', symbol: 'X', side: Side.Buy, qty: 1, type: OrderType.Market, status: OrderStatus.Working };
  orders.set('M', market);
  const parents = createParentLinks({ stores: { order: reader(orders), position: reader(positions), individualPosition: reader(new Map()) }, quotes: reader(quotes), links, keyFor });
  assert.deepEqual([...parents.childLegs('position:P')], ['takeProfit']);
  const edit = parents.confirmedExitParent({ kind: 'bracket', protection: { movingLeg: 'takeProfit', handles: [] } }, 'order', 'TP');
  assert.deepEqual([edit.kind, edit.id, edit.leg, edit.level], ['position', 'P', 'takeProfit', 'L1']);
  assert.equal(parents.confirmedExitParent({ kind: 'order' }, 'order', 'TP'), undefined);
  assert.equal(parents.exitEntryPrice('order', market), 101);
  assert.equal(parents.exitEntryPrice('position', positions.get('P')), 100);
});
