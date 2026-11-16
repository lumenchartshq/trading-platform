import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { reviewActions, reviewLineLocked, reviewProtection } = await loadModule('src/chart/review-lock.ts');

const lock = { reviewedKey: 'position:1', leg: 'takeProfit' };
const both = { handles: ['takeProfit', 'stopLoss'] };
const actions = ['modify', 'cancel'];

test('OC08: protection review removes drag actions from the whole group', () => {
  const reviewed = reviewProtection('position:1', both, lock);
  assert.deepEqual(reviewed.handles, []);
  assert.deepEqual(reviewed.lockedHandles, both.handles);
  for (const key of ['position:1', 'order:tp', 'order:sl']) {
    assert.equal(reviewLineLocked(key, lock), true, key);
    assert.deepEqual(reviewActions(key, actions, lock), ['cancel'], key);
  }
  assert.deepEqual(reviewProtection('order:sl', both, lock).handles, []);
  assert.equal(reviewLineLocked('position:2', undefined), false);
  assert.equal(reviewProtection('position:2', both, undefined), both);
  assert.equal(reviewActions('position:2', actions, undefined), actions);
});

test('OC08: entry review keeps the reviewed entry editable and locks siblings', () => {
  const entry = { ...lock, leg: undefined };
  assert.equal(reviewProtection('position:1', both, entry), both);
  assert.equal(reviewLineLocked('position:1', entry), false);
  assert.equal(reviewLineLocked('order:sl', entry), true);
  assert.equal(reviewProtection('order:sl', both, undefined), both);
  assert.equal(reviewActions('order:sl', actions, undefined), actions);
  assert.equal(reviewLineLocked('order:sl', undefined), false);
});
