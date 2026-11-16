import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { KeyedRefCount, releaseAll } = await loadModule('src/core/keyed-ref-count.ts');

test('D04/A05: keyed demand shares initialization and releases exactly once for its last distinct owner', () => {
  const disposed = [], registry = new KeyedRefCount((value, key) => disposed.push([key, value]));
  let starts = 0;
  const first = registry.acquire('X', () => ({ id: ++starts }));
  const second = registry.acquire('X', () => assert.fail('duplicate initialization'));
  assert.equal(first.value, second.value); assert.equal(starts, 1);
  first.release(); first.release(); assert.deepEqual(disposed, []);
  second.release(); assert.deepEqual(disposed, [['X', first.value]]);
  assert.equal(registry.get('X'), undefined);
});

test('D04/A05: explicit consumer identity retains callback deduplication and stale leases cannot release new demand', () => {
  const disposed = [], registry = new KeyedRefCount((value, key) => disposed.push([key, value]));
  const callback = () => {};
  const first = registry.acquire('X', () => 1, callback);
  const duplicate = registry.acquire('X', () => 2, callback);
  first.release(); duplicate.release(); assert.deepEqual(disposed, [['X', 1]]);
  const old = registry.acquire('X', () => 2);
  registry.releaseAll();
  const fresh = registry.acquire('X', () => 3);
  old.release(); assert.equal(registry.get('X'), 3);
  fresh.release(); assert.deepEqual(disposed.map(item => item[1]), [1, 2, 3]);
});

test('A05: bulk cleanup attempts every release in insertion order and rethrows the first failure', () => {
  const calls = [], failure = new Error('first');
  assert.throws(() => releaseAll([
    () => { calls.push('quote'); throw failure; },
    () => { calls.push('depth'); throw new Error('second'); },
    () => calls.push('finance'),
  ]), error => error === failure);
  assert.deepEqual(calls, ['quote', 'depth', 'finance']);
  const registry = new KeyedRefCount((_value, key) => { calls.push(key); if (key === 'X') throw failure; });
  registry.acquire('X', () => 1); registry.acquire('Y', () => 2);
  assert.throws(() => registry.releaseAll(), error => error === failure);
  assert.equal(registry.get('X'), undefined); assert.equal(registry.get('Y'), undefined);
  assert.deepEqual(calls.slice(-2), ['X', 'Y']);
});
