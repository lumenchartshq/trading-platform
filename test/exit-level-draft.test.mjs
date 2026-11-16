import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { legacyExitLevel, appendExitLevel, removeExitLevel, minimumExitQuantity } = await loadModule('src/core/exit-level-draft.ts');
const rules = { min: 1, max: 100, step: 1 };
const level = (id, qty) => ({ id, qty, takeProfit: 110, stopLoss: 90, isExisting: false });

test('B04: adding exit allocations preserves IDs and prices, reclaims only the needed size and does not mutate inputs', () => {
  const current = [level('a', 4), level('b', 2)], candidate = level('c', 3);
  const before = structuredClone(current), nextBefore = structuredClone(candidate);
  const result = appendExitLevel(current, candidate, 6, rules, 4);
  assert.deepEqual(result.map(x => [x.id, x.qty]), [['a', 2], ['b', 1], ['c', 3]]);
  assert.deepEqual(current, before); assert.deepEqual(candidate, nextBefore);
  assert(result.every(x => x.takeProfit === 110 && x.stopLoss === 90));
  const removed = removeExitLevel(result, 'b'); assert.deepEqual(removed.map(x => x.qty), [2, 3]);
  removed[0].takeProfit = 120; assert.equal(result[0].takeProfit, 110);
});
test('B04: spare allocation is used first and fractional steps remain exact after repeated additions', () => {
  assert.deepEqual(appendExitLevel([level('a', 2)], level('b', 1), 5, rules).map(x => x.qty), [2, 1]);
  const decimal = { min: 0.1, max: 1, step: 0.1 };
  let levels = [level('a', 0.3)];
  levels = appendExitLevel(levels, level('b', 0.1), 0.3, decimal);
  levels = appendExitLevel(levels, level('c', 0.1), 0.3, decimal);
  assert.deepEqual(levels.map(x => x.qty), [0.1, 0.1, 0.1]);
  assert.throws(() => appendExitLevel(levels, level('d', 0.1), 0.3, decimal), /Increase the quantity/);
});
test('B04: invalid IDs, counts, quantities and existing over-allocation reject atomically', () => {
  const current = [level('a', 2)], before = structuredClone(current);
  for (const next of [level('a', 1), level('', 1), level('b', 0), level('b', 0.5), level('b', NaN)])
    assert.throws(() => appendExitLevel(current, next, 2, rules));
  assert.throws(() => appendExitLevel(current, level('b', 1), 2, rules, 1), /maximum number/);
  assert.throws(() => appendExitLevel(current, level('b', 1), 2, rules, 0), /invalid exit level limit/);
  assert.throws(() => appendExitLevel(current, level('b', 1), 1, rules), /Reduce the protected quantity/);
  assert.throws(() => appendExitLevel([level('a', 1)], level('b', 1), 1, rules), /Increase the quantity/);
  assert.deepEqual(current, before);
});
test('B04: a legacy pair becomes a stable draft level without obsolete levels or invented price fields', () => {
  assert.deepEqual(legacyExitLevel({ takeProfit: 110, guaranteedStop: 90, exitLevels: [level('stale', 1)] }, 2, 'draft-1'), {
    id: 'draft-1', qty: 2, takeProfit: 110, stopLoss: undefined, guaranteedStop: 90, trailingStopPips: undefined, isExisting: false,
  });
  assert.deepEqual(removeExitLevel([level('a', 1)], 'a'), []);
});


test('B04: allocation uses the first positive aligned quantity above an unaligned broker minimum', () => {
  const unaligned = { min: 0.021, max: 1, step: 0.02 };
  assert.equal(minimumExitQuantity(unaligned), 0.04);
  assert.deepEqual(appendExitLevel([level('a', 0.08)], level('b', 0.04), 0.08, unaligned).map(x => x.qty), [0.04, 0.04]);
  assert.equal(minimumExitQuantity({ min: 0, max: 1, step: 0.1 }), 0.1);
});
