import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { CommandCoordinator } = await loadModule('src/core/command-coordinator.ts');

function countingSpec(overrides = {}) {
  const counts = { dispose: 0 };
  return { counts, spec: { keys: [`order:${Math.random()}`], dispatch: () => new Promise(() => {}), match: () => undefined, refresh: () => {}, dispose: () => counts.dispose++, ...overrides } };
}

test('O03: a rejection after the deadline marks the unconfirmed record rejected and disposes once', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock), response = deferred();
  const { spec, counts } = countingSpec({ dispatch: () => response.promise });
  const completion = coordinator.execute(spec);
  clock.advance(10000);
  assert.equal((await completion).outcome, 'unconfirmed'); assert.equal(counts.dispose, 0);
  response.reject(new Error('Insufficient margin')); await flush();
  const record = coordinator.pending.get('command-1');
  assert.equal(record.stage, 'rejected'); assert.equal(record.error, 'The broker could not complete the operation.');
  assert.equal(counts.dispose, 1);
  coordinator.changed(); coordinator.destroy(); assert.equal(counts.dispose, 1);
});
test('O03: late acceptance plus a matching update after the deadline confirms the record', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock), response = deferred();
  let updated = false;
  const { spec, counts } = countingSpec({ dispatch: () => response.promise, match: () => updated ? { outcome: 'confirmed', entityIds: ['A'] } : undefined });
  const completion = coordinator.execute(spec);
  clock.advance(10000); assert.equal((await completion).outcome, 'unconfirmed');
  response.resolve(); await flush(); updated = true; coordinator.changed();
  assert.equal(coordinator.pending.get('command-1').stage, 'confirmed'); assert.equal(counts.dispose, 1);
  coordinator.destroy(); assert.equal(counts.dispose, 1);
});
test('O02/O03: a broker rejection learned from a late update stops reconciliation and frees the command keys', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  let rejected = false;
  const { spec, counts } = countingSpec({
    keys: ['place:A:X'], dispatch: async () => {},
    match: () => {
      if (rejected) throw { code: 'rejected', message: 'The broker rejected this order.' };
    },
  });
  const completion = coordinator.execute(spec); await flush();
  clock.advance(10000);
  assert.equal((await completion).outcome, 'unconfirmed');
  rejected = true; coordinator.changed();
  const record = coordinator.pending.get('command-1');
  assert.equal(record.stage, 'rejected');
  assert.equal(record.error, 'The broker rejected this order.');
  assert.equal(record.reconciling, false);
  assert.equal(counts.dispose, 1);
  assert.equal(clock.timers.size, 0);
  const next = coordinator.execute(countingSpec({ keys: ['place:A:X'] }).spec);
  coordinator.destroy(); await assert.rejects(next, error => error.code === 'disposed');
});
test('A03: suspend releases every pending operation listener', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  let listeners = 0;
  const specs = [0, 1, 2].map(() => { listeners++; return countingSpec({ dispose: () => listeners-- }).spec; });
  const completions = specs.map(spec => coordinator.execute(spec));
  assert.equal(listeners, 3);
  coordinator.suspend();
  assert.equal(listeners, 0);
  for (const completion of completions) assert.equal((await completion).outcome, 'unconfirmed');
  coordinator.destroy(); assert.equal(listeners, 0); assert.equal(clock.timers.size, 0);
});
test('A05: destroy disposes each operation exactly once', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  const a = countingSpec(), b = countingSpec({ dispatch: async () => {}, match: () => ({ outcome: 'confirmed', entityIds: [] }) });
  const pending = coordinator.execute(a.spec); const confirmed = coordinator.execute(b.spec); await flush();
  assert.equal((await confirmed).outcome, 'confirmed'); assert.equal(b.counts.dispose, 1);
  coordinator.destroy();
  await assert.rejects(pending, error => error.code === 'disposed');
  assert.equal(a.counts.dispose, 1); assert.equal(b.counts.dispose, 1);
});
test('O03: an unconfirmed command keeps its keys and keeps reconciling with backoff until its window ends', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock, 10000, 30000);
  let refreshes = 0;
  const { spec, counts } = countingSpec({ keys: ['place:A:X'], dispatch: async () => {}, refresh: () => refreshes++ });
  const completion = coordinator.execute(spec); await flush();
  clock.advance(10000); assert.equal((await completion).outcome, 'unconfirmed');
  assert.equal(coordinator.pending.get('command-1').reconciling, true); assert.equal(refreshes, 1);
  await assert.rejects(coordinator.execute(countingSpec({ keys: ['place:A:X'] }).spec), error => error.code === 'operation-pending');
  clock.advance(2000); assert.equal(refreshes, 2);
  clock.advance(4000); assert.equal(refreshes, 3);
  clock.advance(8000); assert.equal(refreshes, 4);
  clock.advance(16000);
  const record = coordinator.pending.get('command-1');
  assert.equal(record.stage, 'unconfirmed'); assert.equal(record.reconciling, false); assert.equal(counts.dispose, 1);
  assert.equal(clock.timers.size, 0);
  const next = coordinator.execute(countingSpec({ keys: ['place:A:X'] }).spec);
  coordinator.destroy(); await assert.rejects(next, error => error.code === 'disposed');
});
test('O03: a late match during reconciliation settles the record, frees its keys and stops follow-ups', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  let updated = false, refreshes = 0;
  const { spec, counts } = countingSpec({ keys: ['place:A:X'], dispatch: async () => {}, refresh: () => refreshes++,
    match: () => updated ? { outcome: 'confirmed', entityIds: ['A'] } : undefined });
  const completion = coordinator.execute(spec); await flush();
  clock.advance(10000); assert.equal((await completion).outcome, 'unconfirmed');
  updated = true; coordinator.changed();
  const record = coordinator.pending.get('command-1');
  assert.equal(record.stage, 'confirmed'); assert.equal(record.reconciling, false); assert.equal(counts.dispose, 1);
  assert.equal(clock.timers.size, 0);
  clock.advance(60000); assert.equal(refreshes, 1);
  const again = coordinator.execute(countingSpec({ keys: ['place:A:X'], dispatch: async () => {}, match: () => ({ outcome: 'confirmed', entityIds: [] }) }).spec);
  await flush(); assert.equal((await again).outcome, 'confirmed');
  coordinator.destroy();
});
test('O03/A03: a zero reconcile window frees keys at the deadline; suspend ends reconciliation', async () => {
  const clock = new ManualClock(), immediate = new CommandCoordinator(clock, 10000, 0);
  let visible = false;
  const first = immediate.execute(countingSpec({ keys: ['order:A'], dispatch: async () => {},
    match: () => visible ? { outcome: 'confirmed', entityIds: ['A'] } : undefined }).spec);
  await flush(); clock.advance(10000); assert.equal((await first).outcome, 'unconfirmed');
  assert.equal(immediate.pending.get('command-1').reconciling, undefined); assert.equal(clock.timers.size, 0);
  // The command ended at its deadline: a later broker match changes account data elsewhere, not this record.
  visible = true; immediate.changed();
  assert.equal(immediate.pending.get('command-1').stage, 'unconfirmed');
  const second = immediate.execute(countingSpec({ keys: ['order:A'] }).spec);
  immediate.destroy(); await assert.rejects(second, error => error.code === 'disposed');
  const coordinator = new CommandCoordinator(clock);
  const { spec, counts } = countingSpec({ keys: ['order:B'] });
  const pending = coordinator.execute(spec);
  clock.advance(10000); assert.equal((await pending).outcome, 'unconfirmed');
  coordinator.suspend();
  assert.equal(coordinator.pending.get('command-1').reconciling, false); assert.equal(counts.dispose, 1);
  assert.equal(clock.timers.size, 0);
  coordinator.destroy();
});
test('A03/O03: late transport results cannot change suspended or expired operations', async () => {
  for (const end of ['suspend', 'expire']) {
    for (const outcome of ['accept', 'reject']) {
      const clock = new ManualClock(), coordinator = new CommandCoordinator(clock, 10000, 1000), response = deferred();
      const completion = coordinator.execute(countingSpec({ dispatch: () => response.promise,
        match: () => ({ outcome: 'confirmed', entityIds: ['A'] }) }).spec);
      clock.advance(10000); await completion;
      if (end === 'suspend') coordinator.suspend();
      else clock.advance(1000);
      const before = coordinator.pending.get('command-1');
      if (outcome === 'accept') response.resolve();
      else response.reject({ code: 'rejected', message: 'Late refusal' });
      await flush();
      assert.deepEqual(coordinator.pending.get('command-1'), before, `${end}: ${outcome}`);
      assert.equal(clock.timers.size, 0);
      coordinator.destroy();
    }
  }
});
test('O03: a synchronous follow-up confirmation leaves no reconciliation timer behind', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  let visible = false, refreshes = 0;
  const completion = coordinator.execute(countingSpec({ dispatch: async () => {},
    match: () => visible ? { outcome: 'confirmed', entityIds: ['A'] } : undefined,
    refresh: () => {
      if (++refreshes === 2) { visible = true; coordinator.changed(); }
    },
  }).spec);
  await flush(); clock.advance(10000); await completion;
  clock.advance(2000);
  assert.equal(coordinator.pending.get('command-1').stage, 'confirmed');
  assert.equal(clock.timers.size, 0);
  coordinator.destroy();
});
