import { mapSettings } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { createDisplayPreferences } = await loadModule('src/core/display-preferences.ts');
function storage(map = new Map()) { return mapSettings(map); }

test('P02/U08: display choices are scoped, versioned, immutable and explicit startup settings win over saved preferences', () => {
  const map = new Map(), port = storage(map), first = createDisplayPreferences(port, 'A');
  assert.deepEqual(first.state.get(), { positionProfitDisplay: 'money', showPositionProfit: true });
  const events = []; first.state.subscribe(value => events.push(value));
  first.update({ positionProfitDisplay: 'ticks' }); first.update({ showPositionProfit: false });
  assert.equal(events.length, 2); assert(Object.isFrozen(events[1]));
  const restored = createDisplayPreferences(port, 'A'), other = createDisplayPreferences(port, 'B');
  assert.deepEqual(restored.state.get(), { positionProfitDisplay: 'ticks', showPositionProfit: false });
  assert.equal(other.state.get().positionProfitDisplay, 'money');
  const explicit = createDisplayPreferences(port, 'A', { positionProfitDisplay: 'percentage' });
  assert.equal(explicit.state.get().positionProfitDisplay, 'percentage'); assert.equal(explicit.state.get().showPositionProfit, false);
  assert.deepEqual(JSON.parse([...map.values()][0]), { schemaVersion: 1, positionProfitDisplay: 'ticks', showPositionProfit: false });
  for (const value of [first, restored, other, explicit]) value.destroy();
  assert.throws(() => first.update({ positionProfitDisplay: 'money' }), { code: 'disposed' });
});

test('P02/U08: malformed saved values fall back safely and invalid runtime patches cannot alter a valid preference', () => {
  for (const raw of ['{', JSON.stringify({ schemaVersion: 2, positionProfitDisplay: 'ticks' }), JSON.stringify({ schemaVersion: 1, positionProfitDisplay: 'wrong' }), 'x'.repeat(513)]) {
    const prefs = createDisplayPreferences({ get: () => raw, set() {}, remove() {} }, 'A');
    assert.equal(prefs.state.get().positionProfitDisplay, 'money'); prefs.destroy();
  }
  const prefs = createDisplayPreferences(storage(), 'A'); let getters = 0;
  for (const patch of [null, [], { positionProfitDisplay: 'wrong' }, { showPositionProfit: 'yes' }, { unknown: 1 }, { get positionProfitDisplay() { getters++; return 'ticks'; } }])
    assert.throws(() => prefs.update(patch), { code: 'invalid-input' });
  assert.equal(getters, 0); assert.equal(prefs.state.get().positionProfitDisplay, 'money'); prefs.destroy();
});

test('P02/A05: persistence failures keep the live choice and explicit save retry does not republish unchanged settings', () => {
  let fail = true, writes = 0, events = 0;
  const prefs = createDisplayPreferences({ get() { throw new Error('read denied'); }, set() { writes++; if (fail) throw new Error('write denied'); }, remove() {} }, 'A');
  prefs.state.subscribe(() => events++);
  prefs.update({ positionProfitDisplay: 'percentage' });
  assert.equal(prefs.state.get().positionProfitDisplay, 'percentage'); assert(prefs.error.get());
  fail = false; prefs.update({}); assert.equal(prefs.error.get(), undefined);
  assert.equal(writes, 2); assert.equal(events, 1); prefs.update({}); assert.equal(writes, 2); prefs.destroy();
});

test('U08: trading page display fields persist, and one invalid saved field does not discard the others', () => {
  const map = new Map(), port = storage(map), prefs = createDisplayPreferences(port, 'A');
  prefs.update({ showReverse: false, lineAlignment: 'left', bracketProfitDisplay: 'percentage', executionSound: true });
  const restored = createDisplayPreferences(port, 'A');
  assert.equal(restored.state.get().showReverse, false); assert.equal(restored.state.get().lineAlignment, 'left');
  assert.equal(restored.state.get().bracketProfitDisplay, 'percentage'); assert.equal(restored.state.get().executionSound, true);
  for (const patch of [{ lineAlignment: 'top' }, { showExecutions: 1 }, { bracketProfitDisplay: 'pips' }])
    assert.throws(() => prefs.update(patch), { code: 'invalid-input' });
  const mixed = createDisplayPreferences({ get: () => JSON.stringify({ schemaVersion: 1, showReverse: false, lineAlignment: 'top' }), set() {}, remove() {} }, 'A');
  assert.equal(mixed.state.get().showReverse, false); assert.equal(mixed.state.get().lineAlignment, undefined);
  for (const value of [prefs, restored, mixed]) value.destroy();
});
