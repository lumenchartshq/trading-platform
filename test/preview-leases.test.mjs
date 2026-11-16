import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { BoundedMap } = await loadModule('src/core/bounded-map.ts');
const { PreviewLeases } = await loadModule('src/core/preview-leases.ts');

test('O03/P04: preview claims retain mismatches and inspections but consume a matching dispatch exactly once', () => {
  const leases = new PreviewLeases('review');
  const value = { account: 'A', amount: 2 };
  const token = leases.issue(value);
  assert.equal(leases.claim(token, entry => entry.account === 'B'), undefined);
  assert.equal(leases.claim(token, entry => entry.account === 'A', false), value);
  assert.equal(leases.claim(token, entry => entry.amount === 2), value);
  assert.equal(leases.claim(token, () => true), undefined);
});

test('O03/P04: preview retention evicts oldest reviews and invalidates only selected dependencies', () => {
  const leases = new PreviewLeases('review', 2);
  const first = leases.issue({ symbol: 'X' });
  const second = leases.issue({ symbol: 'Y' });
  const third = leases.issue({ symbol: 'X' });
  assert.equal(leases.claim(first, () => true), undefined);
  leases.invalidate(value => value.symbol === 'X');
  assert.equal(leases.claim(third, () => true), undefined);
  assert.deepEqual(leases.claim(second, () => true), { symbol: 'Y' });
});

test('U06: bounded formatter retention preserves explicit recency refresh and never evicts on replacement', () => {
  const cache = new BoundedMap(2);
  cache.set('A', 1); cache.set('B', 2); cache.set('B', 3);
  assert.equal(cache.get('A'), 1);
  const recent = cache.get('A'); cache.delete('A'); cache.set('A', recent);
  cache.set('C', 4);
  assert.equal(cache.get('B'), undefined);
  assert.equal(cache.get('A'), 1);
  assert.equal(cache.get('C'), 4);
  cache.clear(); assert.deepEqual([...cache], []);
});
