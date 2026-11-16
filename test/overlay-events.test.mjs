import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { normalizeOverlayEvent } = await loadModule('src/chart/overlay-events.ts');
test('X04/A04: overlay callbacks normalize every action/gesture and detach retained input', () => {
  for (const type of ['modify', 'cancel', 'close', 'reverse', 'protect']) {
    const event = normalizeOverlayEvent({ type, ignored: 'host-only metadata' }); assert.deepEqual(event, { type }); assert(Object.isFrozen(event));
  }
  for (const type of ['dragStart', 'dragPreview', 'dragCommit', 'dragCancel']) {
    for (const price of [-10, 0, 10]) {
      const input = { type, gestureId: 'captured', price }, event = normalizeOverlayEvent(input); input.price = 999;
      assert.deepEqual(event, { type, gestureId: 'captured', price }); assert(Object.isFrozen(event));
    }
  }
});
test('X04/A04: invalid overlay callbacks never invoke accessors or accept missing/nonfinite gesture values', () => {
  let accesses = 0;
  assert.throws(() => normalizeOverlayEvent({ get type() { accesses++; return 'cancel'; } }), error => error.code === 'invalid-input'); assert.equal(accesses, 0);
  for (const input of [null, [], 'cancel', {}, { type: 'unknown' }, { type: 'dragCommit', gestureId: 'id' }, { type: 'dragCommit', gestureId: '', price: 1 }, { type: 'dragCommit', gestureId: 7, price: 1 }, ...[Infinity, NaN, '1'].map(price => ({ type: 'dragCommit', gestureId: 'id', price }))]) assert.throws(() => normalizeOverlayEvent(input), error => error.code === 'invalid-input');
});


test('X04/X09: overlay event normalization reads only its scalar fields and never traverses unrelated host data', () => {
  let traversals = 0, getterReads = 0;
  const unrelated = new Proxy(Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [String(index), index])), { ownKeys(target) { traversals++; return Reflect.ownKeys(target); } });
  const input = { type: 'dragCommit', gestureId: 'bounded', price: 100, unrelated, get ignored() { getterReads++; return []; } };
  for (let index = 0; index < 100; index++) assert.deepEqual(normalizeOverlayEvent(input), { type: 'dragCommit', gestureId: 'bounded', price: 100 });
  assert.equal(traversals, 0); assert.equal(getterReads, 0);
  class HostEvent { type = 'cancel'; }
  assert.throws(() => normalizeOverlayEvent(new HostEvent()), error => error.code === 'invalid-input');
});
