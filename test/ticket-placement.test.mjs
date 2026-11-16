import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { createTicketPlacement } = await loadModule('src/ui/order-ticket/placement.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
function fixture(options = {}) {
  const environment = new ValueStore({ width: 1440, height: 900, locale: 'en', timezone: 'UTC', theme: 'light' });
  const values = options.values ?? new Map(), writes = [], requests = [], errors = [];
  let hostFails = false, storageFails = false;
  const presentation = { environment, setTicketPlacement(value) { assert.equal(this, presentation); if (hostFails) throw new Error('Host unavailable'); requests.push(structuredClone(value)); } };
  if (options.unsupported) delete presentation.setTicketPlacement;
  const preferences = { get: key => values.get(key), set(key, value) { if (storageFails) throw new Error('Storage unavailable'); writes.push([key, value]); values.set(key, value); } };
  const placement = createTicketPlacement(presentation, preferences, error => errors.push(error));
  return { placement, environment, values, writes, requests, errors, hostFails(value) { hostFails = value; }, storageFails(value) { storageFails = value; } };
}

test('U09: floating choice centers the ticket and preserves its geometry on redock and remount', () => {
  const f = fixture(); const { placement } = f;
  assert.equal(placement.state.get().floating, false); assert.equal(f.writes.length, 0);
  assert.equal(placement.toggle(), true);
  assert.deepEqual(placement.state.get().bounds, { x: 512, y: 30, width: 416, height: 840 });
  assert.equal(placement.state.get().floating, true); assert.equal(f.writes.length, 1);
  placement.previewBounds({ x: 300, y: 80, width: 400, height: 650 }); placement.save();
  placement.toggle(); assert.equal(placement.state.get().floating, false); placement.destroy();
  const next = fixture({ values: f.values }); next.placement.toggle();
  assert.deepEqual(next.placement.state.get().bounds, { x: 300, y: 80, width: 400, height: 650 }); next.placement.destroy();
});
test('U09/X09: one hundred transient positions cause no preference writes and completed drag saves once', () => {
  const f = fixture(); f.placement.toggle(); const before = f.writes.length;
  for (let index = 0; index < 100; index++) f.placement.previewPosition(100 + index, 50);
  assert.equal(f.writes.length, before); f.placement.save(); assert.equal(f.writes.length, before + 1);
  assert.equal(f.placement.state.get().bounds.x, 199); assert(Object.isFrozen(f.placement.state.get().bounds)); f.placement.destroy();
});
test('U09: compact presentation retains floating intent without writes and allows explicit redocking', () => {
  const f = fixture(); f.placement.toggle(); const original = f.placement.captureBounds(), writes = f.writes.length;
  f.environment.set({ ...f.environment.get(), width: 390, height: 844 });
  assert.equal(f.placement.state.get().floating, false); assert.equal(f.placement.state.get().desiredFloating, true); assert.equal(f.writes.length, writes);
  f.environment.set({ ...f.environment.get(), width: 1440, height: 900 }); assert.equal(f.placement.state.get().floating, true); assert.deepEqual(f.placement.captureBounds(), original);
  f.environment.set({ ...f.environment.get(), width: 390 }); f.placement.toggle(); assert.equal(f.placement.state.get().desiredFloating, false);
  const after = f.writes.length; assert.equal(f.placement.toggle(), false); assert.equal(f.writes.length, after); f.placement.destroy();
});
test('U09: cancellation restores the requested position after viewport clamping and never undocks a newly docked ticket', () => {
  const values = new Map([['ticket.placement', JSON.stringify({ version: 1, mode: 'floating', bounds: { x: 1300, y: 100, width: 416, height: 600 } })]]);
  const f = fixture({ values }), captured = f.placement.captureBounds(); assert.equal(f.placement.state.get().bounds.x, 1016);
  f.placement.previewBounds({ ...f.placement.state.get().bounds, x: 700 }); f.placement.restoreBounds(captured); assert.equal(f.writes.length, 0);
  f.environment.set({ ...f.environment.get(), width: 2000 }); assert.equal(f.placement.state.get().bounds.x, 1300);
  f.placement.toggle(); f.placement.restoreBounds(captured); assert.equal(f.placement.state.get().desiredFloating, false); f.placement.destroy();
});
test('U09: host failures preserve applied state while storage failure keeps the live layout usable', () => {
  const f = fixture(); f.hostFails(true); assert.equal(f.placement.toggle(), false); assert.equal(f.placement.toggle(), false);
  assert.equal(f.errors.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.placement.state.get().floating, false);
  f.hostFails(false); assert.equal(f.placement.toggle(), true); f.storageFails(true);
  f.placement.previewBounds({ x: 100, y: 50, width: 416, height: 700 }); f.placement.save();
  assert.equal(f.errors.length, 2); assert.equal(f.placement.state.get().bounds.x, 100); f.placement.destroy();
});
test('U09/A05: unsupported hosts and invalid preferences stay docked; disposed models stop applying or persisting', () => {
  for (const raw of ['bad', JSON.stringify({ version: 2, mode: 'floating' }), JSON.stringify({ version: 1, mode: 'floating', bounds: { x: 1, y: 1, width: 0, height: 600 } }), ' '.repeat(1001)]) {
    const f = fixture({ values: new Map([['ticket.placement', raw]]) }); assert.equal(f.placement.state.get().desiredFloating, false); f.placement.destroy();
  }
  const unsupported = fixture({ unsupported: true }); assert.equal(unsupported.placement.toggle(), false); assert.equal(unsupported.writes.length, 0); unsupported.placement.destroy();
  const f = fixture(); f.placement.toggle(); const before = f.requests.length, writes = f.writes.length, state = f.placement.state.get(); f.placement.destroy();
  f.environment.set({ ...f.environment.get(), width: 1000 }); assert.equal(f.placement.toggle(), false); f.placement.previewBounds({ x: 10, y: 10, width: 300, height: 500 }); f.placement.save();
  assert.equal(f.requests.length, before); assert.equal(f.writes.length, writes); assert.equal(f.placement.state.get(), state);
});


test('U09: moving or centering a viewport-clamped ticket never persists the temporary smaller dimensions', () => {
  const f = fixture(); f.placement.toggle();
  f.environment.set({ ...f.environment.get(), height: 500 });
  assert.equal(f.placement.state.get().bounds.height, 484);
  f.placement.previewPosition(200, 8); f.placement.save();
  assert.equal(f.placement.captureBounds().height, 840);
  f.placement.center(); assert.equal(f.placement.captureBounds().height, 840);
  f.environment.set({ ...f.environment.get(), height: 900 }); assert.equal(f.placement.state.get().bounds.height, 840);
  const before = f.requests.length; assert.equal(f.placement.previewPosition(NaN, 0), false); assert.equal(f.requests.length, before);
  f.placement.destroy();
});
