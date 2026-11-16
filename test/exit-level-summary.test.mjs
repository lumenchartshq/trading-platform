import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { exitLevelRewardRisk } = await loadModule('src/core/exit-level-summary.ts');
const { Side } = await loadModule('src/contracts/broker.ts');
const instrument = { minTick: 0.01, pipSize: 0.01 };
test('B04: aggregate reward/risk weights protected quantities across ordinary, guaranteed and trailing stops', () => {
  const levels = [
    { id: 'ordinary', qty: 3, takeProfit: 103, stopLoss: 99 },
    { id: 'guaranteed', qty: 1, takeProfit: 102, guaranteedStop: 98 },
    { id: 'trailing', qty: 2, takeProfit: 101, trailingStopPips: 50 },
  ];
  assert.equal(exitLevelRewardRisk(levels, 100, Side.Buy, instrument), 13 / 6);
  assert.equal(exitLevelRewardRisk([{ id: 'partial', qty: 3, takeProfit: 340.34, stopLoss: 341.34 }], 341.09, Side.Sell, instrument), 3);
  assert.equal(exitLevelRewardRisk([{ id: 'negative', qty: 2, takeProfit: -8, stopLoss: -11 }], -10, Side.Buy, instrument), 2);
});
test('B04: missing, non-finite, unpaired and wrong-side protection never produces a misleading ratio', () => {
  const paired = { id: 'a', qty: 1, takeProfit: 103, stopLoss: 99 };
  for (const levels of [[], [{ ...paired, qty: 0 }], [{ ...paired, qty: NaN }], [{ ...paired, takeProfit: Infinity }], [{ ...paired, stopLoss: undefined }], [{ ...paired, stopLoss: 101 }], [{ ...paired, takeProfit: 99 }]])
    assert.equal(exitLevelRewardRisk(levels, 100, Side.Buy, instrument), undefined);
  assert.equal(exitLevelRewardRisk([paired], undefined, Side.Buy, instrument), undefined);
});
