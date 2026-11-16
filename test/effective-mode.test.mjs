import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { resolveEffectiveMode } = await loadModule('src/ui/effective-mode.ts');
const { effectiveQuantityMode, effectiveExitMode } = await loadModule('src/ui/order-ticket/mode-rules.ts');

test('U04/B01: risk sizing falls back immediately and requires an explicit choice after availability returns', () => {
  let allowed = true, stop = 99;
  let choice = { mode: 'riskMoney', revision: 1 };
  const normalize = mode => effectiveQuantityMode(mode, allowed, stop);
  let state = resolveEffectiveMode(undefined, choice, normalize);
  assert.equal(state.mode, 'riskMoney');
  stop = undefined; state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'units');
  stop = 99; state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'units');
  choice = { mode: 'riskMoney', revision: 2 };
  state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'riskMoney');
  allowed = false; state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'units');
  assert.equal(effectiveQuantityMode('percentage', false, undefined), 'percentage');
});

test('B01/U04: exit money modes fall back without restoring a rejected choice when permissions recover', () => {
  let allowed = true;
  const choice = { mode: 'equityPercentage', revision: 1 };
  const normalize = mode => effectiveExitMode(mode, allowed);
  let state = resolveEffectiveMode(undefined, choice, normalize);
  allowed = false; state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'price');
  allowed = true; state = resolveEffectiveMode(state, choice, normalize);
  assert.equal(state.mode, 'price');
  assert.equal(effectiveExitMode('distance', false), 'distance', 'distance has a reversible display fallback owned by the field');
});
