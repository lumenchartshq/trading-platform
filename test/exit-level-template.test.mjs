import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { resolveExitLevelTemplates } = await loadModule('src/core/exit-level-template.ts');
const instrument = { qty: { min: 1, max: 100, step: 1 }, minTick: 0.01, pipSize: 0.01, pipValue: 1, currency: 'USD' };
test('B04/P03: exit level templates resolve pips, parent-price percent, money and equity percent into prices', () => {
  const [level] = resolveExitLevelTemplates([{ id: 'a', qty: 2, tpPips: 50, slPips: 25 }], { entry: 100, side: 1, instrument });
  assert.deepEqual(level, { id: 'a', qty: 2, takeProfit: 100.5, stopLoss: 99.75 }, 'template fields are not forwarded');
  const [sell] = resolveExitLevelTemplates([{ id: 'b', qty: 2, tpParentPricePercent: 1, slParentPricePercent: 2 }], { entry: 100, side: -1, instrument });
  assert.equal(sell.takeProfit, 99); assert.equal(sell.stopLoss, 102);
  const [money] = resolveExitLevelTemplates([{ id: 'c', qty: 2, tpRiskInCurrency: 4, slRiskInPercent: 1 }], { entry: 100, side: 1, instrument, equity: 1000, pipValue: 1, accountCurrency: 'USD' });
  assert.equal(money.takeProfit, 100.02, '4 USD over 2 units at 1 USD/pip is 2 pips');
  assert.equal(money.stopLoss, 99.95, '1% of 1000 USD over 2 units is 5 pips');
});
test('B04/P03: explicit prices win and unresolvable templates become invalid instead of invented', () => {
  const [kept] = resolveExitLevelTemplates([{ id: 'a', qty: 1, takeProfit: 101, tpPips: 99 }], { entry: 100, side: 1, instrument });
  assert.equal(kept.takeProfit, 101); assert.equal('tpPips' in kept, false);
  const [missing] = resolveExitLevelTemplates([{ id: 'b', qty: 1, tpRiskInPercent: 1, slPips: 10 }], { side: 1, instrument });
  assert(Number.isNaN(missing.takeProfit)); assert(Number.isNaN(missing.stopLoss), 'no entry price means no distance-based price');
  const [noEquity] = resolveExitLevelTemplates([{ id: 'c', qty: 1, slRiskInPercent: 1 }], { entry: 100, side: 1, instrument, pipValue: 1 });
  assert(Number.isNaN(noEquity.stopLoss));
});
