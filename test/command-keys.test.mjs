import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { commandKeys } = await loadModule('src/core/command-keys.ts');
const { bracketParent } = await loadModule('src/core/bracket-parent.ts');

test('B05: bracket parents and position commands lock the same individual position key', () => {
  const child = { id: 'tp', symbol: 'X', qty: 1, side: -1, type: 1, status: 6, parentId: 'ind-1', parentType: 3 };
  assert.equal(bracketParent(child).key, commandKeys.position('ind-1', true));
  assert.equal(bracketParent({ ...child, parentType: 2 }).key, commandKeys.position('ind-1'));
  assert.equal(bracketParent({ ...child, parentType: 1 }).key, commandKeys.order('ind-1'));
  assert.notEqual(commandKeys.position('a', true), commandKeys.position('a'));
});

test('B05: active protection children match parent type as well as parent ID', async () => {
  const { activeProtectionChildren } = await loadModule('src/core/bracket-parent.ts');
  const base = { symbol: 'X', qty: 1, side: -1, type: 1, status: 6, parentId: 'same' };
  const orders = new Map([
    ['position-tp', { ...base, id: 'position-tp', parentType: 2 }],
    ['order-tp', { ...base, id: 'order-tp', parentType: 1 }],
    ['filled-sl', { ...base, id: 'filled-sl', parentType: 2, status: 2 }],
  ]);
  const reader = { ids: () => [...orders.keys()], get: id => orders.get(id) };
  assert.deepEqual(activeProtectionChildren(reader, 'position', 'same').map(order => order.id), ['position-tp']);
  assert.deepEqual(activeProtectionChildren(reader, 'order', 'same').map(order => order.id), ['order-tp']);
});
