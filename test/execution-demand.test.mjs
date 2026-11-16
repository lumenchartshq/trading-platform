import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { createExecutionDemand } = await loadModule('src/core/execution-demand.ts');
const { createTradingState } = await loadModule('src/core/trading-state.ts');
const execution = (id, symbol, price = 10) => ({ id, symbol, side: 1, qty: 1, price, time: 1700000000 });
function fixture() {
  const state = createTradingState(), clock = new ManualClock(), calls = [], errors = [];
  const demand = createExecutionDemand(state.executions, symbol => {
    const pending = deferred(); calls.push({ symbol, pending }); return pending.promise;
  }, clock, cause => errors.push(cause));
  return { state, clock, calls, errors, demand };
}
test('A04/X02: execution demand shares symbol reads and preserves other symbol snapshots', async () => {
  const f = fixture();
  const release1 = f.demand.acquire('X'), release2 = f.demand.acquire('X'), releaseY = f.demand.acquire('Y');
  assert.equal(f.calls.length, 0);
  f.demand.resume(); assert.deepEqual(f.calls.map(call => call.symbol), ['X', 'Y']);
  f.demand.push(execution('X1', 'X', 12));
  f.calls[0].pending.resolve([execution('X1', 'X', 10)]);
  f.calls[1].pending.resolve([execution('Y1', 'Y', 20)]);
  await flush();
  assert.equal(f.state.executions.get('X1').price, 12);
  assert.equal(f.state.executions.get('Y1').price, 20);
  release1(); release1(); assert.equal(f.clock.timers.size, 0);
  release2(); releaseY(); f.demand.destroy();
});
test('A03/A05: execution account handoff fences old reads and rereads demanded symbols', async () => {
  const f = fixture(), release = f.demand.acquire('X');
  f.demand.resume(); f.demand.suspend(true); f.demand.resume();
  f.calls[0].pending.resolve([execution('old', 'X')]);
  f.calls[1].pending.resolve([execution('new', 'X')]); await flush();
  assert.equal(f.state.executions.get('old'), undefined);
  assert.equal(f.state.executions.get('new').id, 'new');
  assert.equal(f.errors.length, 0);
  f.demand.suspend(); assert.equal(f.state.executions.get('new').id, 'new');
  f.demand.resume(); release();
  f.calls[2].pending.resolve([execution('late', 'X')]); await flush();
  assert.equal(f.state.executions.get('late'), undefined);
  assert.equal(f.clock.timers.size, 0);
  f.demand.destroy();
});
test('A04: malformed cross-symbol execution snapshot is rejected atomically', async () => {
  const f = fixture(), release = f.demand.acquire('X'); f.demand.resume();
  f.calls[0].pending.resolve([execution('valid', 'X'), execution('wrong', 'Y')]); await flush();
  assert.deepEqual(f.state.executions.ids(), []);
  assert.equal(f.errors.length, 1);
  release(); f.demand.destroy();
});
