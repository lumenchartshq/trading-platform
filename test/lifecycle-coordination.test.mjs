import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { SnapshotDataset } = await loadModule('src/core/snapshot-dataset.ts');
const { EntityStore } = await loadModule('src/core/entity-store.ts');
const { CommandCoordinator } = await loadModule('src/core/command-coordinator.ts');

test('A04: snapshot pushes replay in arrival order and duplicate full refreshes coalesce to one follow-up', async () => {
  const clock = new ManualClock(), store = new EntityStore(() => {}), reads = [];
  const dataset = new SnapshotDataset(store, () => { const read = deferred(); reads.push(read); return read.promise; }, clock);
  const changes = []; store.subscribeChanges(change => changes.push(change));
  const first = dataset.refresh();
  dataset.push({ id: 'A', price: 11 }); dataset.partial('A', { price: 12 });
  dataset.refresh(); dataset.refresh(); dataset.refresh();
  reads[0].resolve([{ id: 'A', price: 10 }]); await first; await flush();
  assert.equal(store.get('A').price, 12); assert.equal(changes.length, 1); assert.equal(reads.length, 2);
  reads[1].resolve([{ id: 'A', price: 12 }]); await flush();
  assert.equal(changes.length, 1); assert.equal(reads.length, 2); assert.equal(clock.timers.size, 0);
  dataset.destroy(); store.destroy();
});
test('A04: unknown partial IDs cause one read and never create phantom entities', async () => {
  const clock = new ManualClock(), store = new EntityStore(() => {}), read = deferred(), diagnostics = [];
  let calls = 0;
  const dataset = new SnapshotDataset(store, () => { calls++; return read.promise; }, clock, undefined, message => diagnostics.push(message));
  dataset.partial('missing', { price: 12 }); dataset.partial('missing', { price: 13 });
  assert.equal(calls, 1); assert.equal(store.get('missing'), undefined);
  read.resolve([]); await flush();
  assert.equal(calls, 1); assert.equal(store.get('missing'), undefined); assert.equal(diagnostics.length, 2);
  dataset.destroy();
});
test('A03/A05: account invalidation fences old reads, and read timeout fences late data', async () => {
  const clock = new ManualClock(), store = new EntityStore(() => {}), reads = [];
  const dataset = new SnapshotDataset(store, () => { const read = deferred(); reads.push(read); return read.promise; }, clock);
  const first = dataset.refresh(); dataset.invalidate(true);
  await assert.rejects(first, error => error.code === 'stale-context');
  const second = dataset.refresh(); reads[0].resolve([{ id: 'old' }]); await flush();
  assert.equal(store.get('old'), undefined);
  clock.advance(15000); await assert.rejects(second, /too long/);
  reads[1].resolve([{ id: 'late' }]); await flush(); assert.equal(store.get('late'), undefined);
  assert.equal(dataset.status.get().status, 'error');
  const third = dataset.refresh(); dataset.destroy(); await assert.rejects(third); assert.equal(clock.timers.size, 0);
});
test('A04: failed refresh retains known data and applies buffered broker pushes', async () => {
  const clock = new ManualClock(), store = new EntityStore(() => {}), read = deferred();
  store.upsert({ id: 'A', price: 10 });
  const dataset = new SnapshotDataset(store, () => read.promise, clock);
  const refresh = dataset.refresh(); dataset.push({ id: 'A', price: 20 }); read.reject(new Error('offline'));
  await assert.rejects(refresh, /offline/); assert.equal(store.get('A').price, 20); assert.equal(dataset.status.get().status, 'stale');
  dataset.destroy();
});
test('O01/O03: update before response waits for transport, response without update times out without resending', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock), response = deferred();
  let updated = false, calls = 0, refreshes = 0;
  const completion = coordinator.execute({ keys: ['order:A'], dispatch: () => { calls++; return response.promise; }, match: () => updated ? { outcome: 'confirmed', entityIds: ['A'] } : undefined, refresh: () => refreshes++ });
  updated = true; coordinator.changed(); assert.equal(coordinator.pending.get('command-1').stage, 'dispatched');
  response.resolve(); await flush(); assert.equal((await completion).outcome, 'confirmed');
  updated = false;
  const timeout = coordinator.execute({ keys: ['order:A'], dispatch: async () => { calls++; }, match: () => undefined, refresh: () => refreshes++ });
  await flush(); clock.advance(9999); assert.equal(coordinator.pending.get('command-2').stage, 'awaitingUpdate');
  clock.advance(1); assert.equal((await timeout).outcome, 'unconfirmed'); assert.equal(calls, 2); assert.equal(refreshes, 1);
  coordinator.destroy(); assert.equal(clock.timers.size, 0);
});
test('O02/A05: broker rejection, duplicate entity reservations, hung transport and disposal settle once', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock), hung = deferred();
  const spec = { keys: ['order:A'], dispatch: () => hung.promise, match: () => undefined, refresh: () => {} };
  const pending = coordinator.execute(spec);
  await assert.rejects(coordinator.execute(spec), error => error.code === 'operation-pending');
  coordinator.destroy(); coordinator.destroy(); await assert.rejects(pending, error => error.code === 'disposed');
  hung.resolve(); await flush(); assert.equal(clock.timers.size, 0);
  const second = new CommandCoordinator(clock);
  await assert.rejects(second.execute({ ...spec, dispatch: () => Promise.reject(new Error('no funds')) }), error => error.code === 'broker-rejected' && error.cause.message === 'no funds');
  const timeout = second.execute(spec); clock.advance(10000); assert.equal((await timeout).outcome, 'unconfirmed');
  second.destroy();
});
