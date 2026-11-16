import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, flush } from './manual-clock.mjs';
const { CommandCoordinator } = await loadModule('src/core/command-coordinator.ts');
const { followCommand } = await loadModule('src/core/command-follow.ts');

function unconfirmed(options = {}) {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock, 10000, options.window ?? 60000);
  let updated = false;
  const reply = { resolve: undefined, reject: undefined };
  const completion = coordinator.execute({
    keys: ['place:A:X'],
    dispatch: () => new Promise((resolve, reject) => { reply.resolve = resolve; reply.reject = reject; }),
    match: () => updated ? { outcome: 'confirmed', entityIds: ['A'] } : undefined,
    refresh: () => {},
  });
  return { clock, coordinator, completion, reply, match() { updated = true; coordinator.changed(); } };
}

test('O03: following reports checking once, then the late confirmation, then stops', async () => {
  const f = unconfirmed();
  f.clock.advance(10000);
  const { commandId } = await f.completion;
  const states = [];
  followCommand(f.coordinator.pending, commandId, state => states.push(state.kind));
  f.reply.resolve(); await flush();
  f.match();
  f.coordinator.changed();
  assert.deepEqual(states, ['checking', 'confirmed']);
  f.coordinator.destroy();
  assert.deepEqual(states, ['checking', 'confirmed']);
});

test('O03: a late rejection and an exhausted window are final; dispose stops reports', async () => {
  const rejected = unconfirmed();
  rejected.clock.advance(10000);
  const states = [];
  followCommand(rejected.coordinator.pending, (await rejected.completion).commandId, state => states.push(state));
  rejected.reply.reject(new Error('no margin')); await flush();
  assert.equal(states.at(-1).kind, 'rejected');
  assert.match(states.at(-1).error, /could not complete/);
  rejected.coordinator.destroy();

  const lost = unconfirmed({ window: 5000 });
  lost.clock.advance(10000);
  const kinds = [];
  followCommand(lost.coordinator.pending, (await lost.completion).commandId, state => kinds.push(state.kind));
  lost.clock.advance(5000);
  assert.deepEqual(kinds, ['checking', 'unresolved']);
  lost.coordinator.destroy();

  const stopped = unconfirmed();
  stopped.clock.advance(10000);
  const seen = [];
  const stop = followCommand(stopped.coordinator.pending, (await stopped.completion).commandId, state => seen.push(state.kind));
  stop();
  stopped.reply.resolve(); await flush(); stopped.match();
  assert.deepEqual(seen, ['checking']);
  stopped.coordinator.destroy();
});

const { watchAcceptance } = await loadModule('src/core/command-follow.ts');
test('O01: acceptance is reported once for the newest command on a key, never for an older one', async () => {
  const clock = new ManualClock(), coordinator = new CommandCoordinator(clock);
  const old = { resolve: undefined };
  coordinator.execute({ keys: ['place:A:Y'], dispatch: () => new Promise(resolve => { old.resolve = resolve; }), match: () => undefined, refresh: () => {} });
  clock.advance(1);
  const seen = [];
  const stop = watchAcceptance(coordinator.pending, 'place:A:X', clock.now(), () => seen.push('accepted'));
  old.resolve(); await flush();
  assert.deepEqual(seen, []);
  const reply = { resolve: undefined };
  coordinator.execute({ keys: ['place:A:X'], dispatch: () => new Promise(resolve => { reply.resolve = resolve; }), match: () => undefined, refresh: () => {} });
  await flush(); assert.deepEqual(seen, []);
  reply.resolve(); await flush();
  assert.deepEqual(seen, ['accepted']);
  stop(); coordinator.destroy();
});
