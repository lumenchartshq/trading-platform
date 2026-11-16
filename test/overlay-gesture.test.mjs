import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { createOverlayGestures } = await loadModule('src/chart/overlay-gesture.ts');

function stub({ current = true } = {}) {
  const calls = { begin: 0, clearIf: [], actions: [], updates: [], leases: 0, released: 0, cancels: 0 };
  let edit;
  const session = {
    chartEdits: {
      state: { get: () => edit },
      begin: (id, kind, binding, options) => { calls.begin++; edit = { token: 7, id, kind, binding, phase: 'dragging', leg: options?.leg, context: { revision: 1 } }; },
      clearIf: token => { calls.clearIf.push(token); if (edit?.token === token) edit = undefined; },
    },
    acquireFinancial: () => { calls.leases++; return () => { calls.released++; }; },
    state: { quotes: { get: () => undefined } },
  };
  const host = {
    session, onAction: action => calls.actions.push(action), onError: error => { throw error; }, safely: work => work(),
    instrument: () => undefined, exitText: () => '—', currentAccountCurrency: () => 'USD',
    lockFor: () => undefined, shownProtection: (_owner, projection, preview) => preview ?? projection.spec.protection,
    releaseEdit: () => {}, displayOn: (_key, begin) => begin(), updateOverlay: (_handle, patch) => calls.updates.push(patch),
    multipleExitLevels: () => false, pipFinanceNeeded: () => true, completedParent: () => undefined, confirmedExitParent: () => undefined,
  };
  const projection = { kind: 'order', id: 'O', revision: 1, spec: { key: 'order:O', kind: 'order', price: 98, actions: ['modify'], protection: { handles: ['stopLoss'] } } };
  const overlay = { handle: { cancelInteraction: () => { calls.cancels++; } }, scope: { own: release => release }, projection };
  const owner = { binding: { id: 'A', generation: 1, symbol: 'X' }, overlays: new Map([['order:O', overlay]]) };
  const gestures = createOverlayGestures(host);
  return { calls, gestures, overlay, fire: gestures.handler(owner, overlay, 'order:O', () => current) };
}

test('X05/OC06: eligibility follows the dragged leg, or modify for a body move', () => {
  const { gestures } = stub();
  const projection = { spec: { actions: ['modify'], protection: { handles: ['stopLoss'] } } };
  assert.equal(gestures.gestureEligible(projection, 'stopLoss'), true);
  assert.equal(gestures.gestureEligible(projection, 'takeProfit'), false);
  assert.equal(gestures.gestureEligible({ spec: { actions: [], protection: { handles: [] } } }, undefined), false);
});
test('X05/OC06: a leg drag owns one edit and one pip lease; an ineligible commit ends it without dispatching', () => {
  const { calls, fire, overlay } = stub();
  fire({ type: 'dragStart', gestureId: 'G', leg: 'stopLoss', price: 98 });
  assert.equal(calls.begin, 1); assert.equal(calls.leases, 1); assert.equal(overlay.gestureId, 'G'); assert.equal(overlay.gestureLeg, 'stopLoss');
  fire({ type: 'dragCommit', gestureId: 'G', leg: 'takeProfit', price: 110 });
  assert.equal(calls.actions.length, 0); assert.equal(calls.released, 1); assert.deepEqual(calls.clearIf, [7]);
  assert.equal(overlay.gestureId, undefined); assert.equal(calls.updates.at(-1).price, 98);
});
test('X05: events for an overlay that is no longer current are ignored', () => {
  const { calls, fire } = stub({ current: false });
  fire({ type: 'dragStart', gestureId: 'G', leg: 'stopLoss', price: 98 });
  fire({ type: 'modify' });
  assert.equal(calls.begin, 0); assert.equal(calls.actions.length, 0);
});
