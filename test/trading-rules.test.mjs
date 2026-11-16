import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { aligned, snapToStep, floorToStep, effectiveTick, validatePreOrder } = await loadModule('src/core/trading-rules.ts');
const { resolveCapabilities, durationsForType } = await loadModule('src/core/capabilities.ts');
const instrument = { description: 'X', minTick: 0.01, pipSize: 0.01, pipValue: 1, qty: { min: 0.1, max: 10, step: 0.1 } };
const order = { symbol: 'X', side: 1, qty: 0.3, type: 1, limitPrice: -10.25 };
test('O08: decimal-safe alignment, negative prices and variable tick boundaries', () => {
  assert.equal(aligned(0.3, 0.1), true); assert.equal(aligned(0.31, 0.1), false); assert.equal(aligned(1e-7, 1e-8), true);
  assert.equal(snapToStep(-10.26, 0.25), -10.25); assert.equal(floorToStep(0.39, 0.1), 0.3);
  const variable = { minTick: 0.01, variableMinTick: '0.01 10 0.02 25 0.05' };
  assert.equal(effectiveTick(9.99, variable), 0.01); assert.equal(effectiveTick(10, variable), 0.02); assert.equal(effectiveTick(25, variable), 0.05);
  assert.throws(() => effectiveTick(10, { ...variable, variableMinTick: '0.01 25 0.02 10 0.05' }), /schedule/);
  validatePreOrder(order, instrument, resolveCapabilities(), undefined, 0);
  assert.throws(() => validatePreOrder({ ...order, qty: 0.31 }, instrument, resolveCapabilities(), undefined, 0), /quantity/);
  assert.throws(() => validatePreOrder({ ...order, limitPrice: -10.251 }, instrument, resolveCapabilities(), undefined, 0), /price/);
});
test('O08: stop direction, touched flags, strict limits and missing quotes', () => {
  const stop = { ...order, type: 3, stopPrice: 11 }, policy = resolveCapabilities();
  assert.throws(() => validatePreOrder(stop, instrument, policy, undefined, 0), /quote/);
  validatePreOrder(stop, instrument, policy, { ask: 10 }, 0);
  assert.throws(() => validatePreOrder({ ...stop, stopPrice: 9 }, instrument, policy, { ask: 10 }, 0), /wrong side/);
  validatePreOrder({ ...stop, stopPrice: 9 }, instrument, resolveCapabilities({ configFlags: { supportStopOrdersInBothDirections: true } }), { ask: 10 }, 0);
  assert.throws(() => validatePreOrder({ ...order, limitPrice: 11 }, instrument, resolveCapabilities({ configFlags: { supportStrictCheckingLimitOrderPrice: true } }), { ask: 10 }, 0), /wrong side/);
});
test('U02: duration defaults exclude market and expiration is Unix seconds against injected time', () => {
  const policy = resolveCapabilities({ configFlags: {}, durations: [{ name: 'Good until', value: 'GTD', hasDatePicker: true }] });
  assert.equal(durationsForType(policy, 2).length, 0);
  validatePreOrder({ ...order, duration: { type: 'GTD', datetime: 1700000100 } }, instrument, policy, undefined, 1700000000000);
  assert.throws(() => validatePreOrder({ ...order, duration: { type: 'GTD', datetime: 1699999900 } }, instrument, policy, undefined, 1700000000000), /future/);
});
test('O06/U02: expiry validation tolerates a session clock slightly ahead of the broker', () => {
  const policy = resolveCapabilities({ configFlags: {}, durations: [{ name: 'GTD', value: 'GTD', hasDatePicker: true, hasTimePicker: true }] });
  const now = 1_700_000_000_000;
  const gtd = datetime => ({ ...order, limitPrice: 10, duration: { type: 'GTD', datetime } });
  assert.doesNotThrow(() => validatePreOrder(gtd(now / 1000 - 30), instrument, policy, undefined, now), 'within the default 60 s');
  assert.throws(() => validatePreOrder(gtd(now / 1000 - 61), instrument, policy, undefined, now), /future expiration/);
  assert.throws(() => validatePreOrder(gtd(now / 1000 - 30), instrument, policy, undefined, now, 0), /future expiration/);
  assert.doesNotThrow(() => validatePreOrder(gtd(now / 1000 - 100), instrument, policy, undefined, now, 120));
});
