import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { ReadCoordinator } = await loadModule('src/core/read-coordinator.ts');

test('A03/A05: invalidation immediately rejects every read and fences late provider settlements', async () => {
  const clock = new ManualClock();
  let generation = 1;
  const reads = new ReadCoordinator(clock, () => generation);
  const first = deferred(), second = deferred();
  const one = assert.rejects(reads.read(() => first.promise), { code: 'stale-context' });
  const two = assert.rejects(reads.read(() => second.promise), { code: 'stale-context' });
  generation++;
  reads.invalidate();
  await Promise.all([one, two]);
  assert.equal(clock.timers.size, 0);
  first.resolve('old'); second.reject(new Error('late rejection'));
  await flush();
  assert.equal(await reads.read(() => 'new'), 'new');
  let calls = 0;
  await assert.rejects(reads.read(() => ++calls, 1), { code: 'stale-context' });
  assert.equal(calls, 0);
  reads.destroy();
});

test('A05: deadline, synchronous failure and disposal settle once and release timers', async () => {
  const clock = new ManualClock();
  const reads = new ReadCoordinator(clock, () => 0);
  const hung = deferred();
  const timeout = assert.rejects(reads.read(() => hung.promise), { code: 'broker-unavailable' });
  clock.advance(14999); assert.equal(clock.timers.size, 1);
  clock.advance(1); await timeout;
  assert.equal(clock.timers.size, 0);
  await assert.rejects(reads.read(() => { throw new Error('sync'); }), /sync/);
  const closing = assert.rejects(reads.read(() => hung.promise), { code: 'disposed' });
  reads.destroy(); reads.destroy(); await closing;
  let calls = 0;
  await assert.rejects(reads.read(() => ++calls), { code: 'disposed' });
  assert.equal(calls, 0); assert.equal(clock.timers.size, 0);
  hung.resolve('late'); await flush();
});
