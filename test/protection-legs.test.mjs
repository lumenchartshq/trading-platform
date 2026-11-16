import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { childProtectionField, childProtectionValue, expectedProtectionLegs, matchesProtectionLegs } = await loadModule('src/core/protection-legs.ts');

test('B05/P01: child orders map to bracket fields in both directions', () => {
  assert.equal(childProtectionField({ type: 1 }), 'takeProfit');
  assert.equal(childProtectionField({ type: 3 }), 'stopLoss');
  assert.equal(childProtectionField({ type: 3, stopType: 1 }), 'trailingStopPips');
  assert.equal(childProtectionField({ type: 3, stopType: 2 }), 'guaranteedStop');
  assert.equal(childProtectionField({ type: 2 }), undefined);
  assert.equal(childProtectionValue({ limitPrice: 110, stopPrice: 90, trailingStopPips: 5 }, 'takeProfit'), 110);
  assert.equal(childProtectionValue({ limitPrice: 110, stopPrice: 90, trailingStopPips: 5 }, 'trailingStopPips'), 5);
  const legs = expectedProtectionLegs({ takeProfit: 110, trailingStopPips: 5 }, 2);
  assert.deepEqual(legs.map(leg => [leg.type, leg.price, leg.stopType, leg.qty]), [[1, 110, undefined, 2], [3, undefined, 1, 2]]);
});

test('B05/P01: confirmation needs every expected child, no extras, and the allocated level identity', () => {
  const expected = expectedProtectionLegs({ exitLevels: [{ id: 'a', qty: 1, takeProfit: 110, stopLoss: 90 }] }, 2);
  const tp = { id: 'tp', type: 1, qty: 1, limitPrice: 110, exitLevelId: 'a', parentId: 'P' };
  const sl = { id: 'sl', type: 3, qty: 1, stopPrice: 90, stopType: 0, exitLevelId: 'a', parentId: 'P' };
  assert.equal(matchesProtectionLegs([tp, sl], expected), true);
  assert.equal(matchesProtectionLegs([tp], expected), false);
  assert.equal(matchesProtectionLegs([tp, { ...sl, exitLevelId: 'b' }], expected), false);
  assert.equal(matchesProtectionLegs([tp, sl, { ...sl, id: 'extra' }], expected), false);
  assert.equal(matchesProtectionLegs([tp, { ...sl, stopPrice: 91 }], expected), false);
});
