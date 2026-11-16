import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { PROTECTION_FIELDS, protectionUnchanged, validatePositionProtection } = await loadModule('src/core/protection-rules.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const { Side } = await loadModule('src/contracts/broker.ts');
const instrument = { description: 'X', minTick: 0.01, pipSize: 0.01, pipValue: 1, qty: { min: 1, max: 100, step: 1 } };
const policy = resolveCapabilities({ configFlags: { supportPositionBrackets: true, supportPositions: true } });
const position = { id: 'P', symbol: 'X', side: Side.Buy, qty: 2, avgPrice: 100 };

test('B01/C03: position protection is normalised, checked against the closing price and permission-checked in one rule', () => {
  const normalized = validatePositionProtection(position, { takeProfit: 110, stopLoss: 95, exitLevels: undefined }, instrument, policy, { bid: 101, ask: 101.02 }, undefined, false);
  assert.equal(normalized.takeProfit, 110); assert.equal(normalized.stopLoss, 95);
  assert.throws(() => validatePositionProtection(position, { takeProfit: 110.004 }, instrument, policy, undefined, undefined, false), /step/);
  assert.throws(() => validatePositionProtection(position, { stopLoss: 102 }, instrument, policy, { bid: 101, ask: 101.02 }, undefined, false), /current price/);
  const noBrackets = resolveCapabilities({ configFlags: { supportPositions: true, supportPositionBrackets: false, supportIndividualPositionBrackets: false } });
  assert.throws(() => validatePositionProtection(position, { takeProfit: 110 }, instrument, noBrackets, undefined, undefined, false));
});
test('B01: protection change detection names only requested fields', () => {
  assert.deepEqual([...PROTECTION_FIELDS], ['takeProfit', 'stopLoss', 'guaranteedStop', 'trailingStopPips', 'exitLevels']);
  assert.equal(protectionUnchanged({ takeProfit: 110, stopLoss: 95 }, { takeProfit: 110 }), true);
  assert.equal(protectionUnchanged({ takeProfit: 110 }, { takeProfit: 111 }), false);
  assert.equal(protectionUnchanged({ takeProfit: 110 }, { takeProfit: undefined }), false, 'removing a leg is a change');
});
