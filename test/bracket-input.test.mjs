import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { bracketInputValue, bracketInputPrice } = await loadModule('src/core/bracket-input.ts');
const instrument = { minTick: .01, pipSize: .1 };
const context = { entry: 100, side: 1, profit: true, instrument };
test('B01/U01: bracket price and pip distance round trip for both sides and both protections', () => {
  for (const side of [1, -1]) for (const profit of [true, false]) {
    const input = { ...context, side, profit };
    const price = 100 + .75 * side * (profit ? 1 : -1);
    assert.equal(bracketInputValue(price, 'distance', input), 7.5);
    assert.equal(bracketInputPrice(7.5, 'distance', input), price);
    assert.equal(bracketInputValue(price, 'percentage', input), .75);
    assert.equal(bracketInputPrice(.75, 'percentage', input), price);
  }
});
test('B01/O08: invalid bases remain unavailable, negative entry prices use absolute percentage, typed prices stay unrounded', () => {
  assert.equal(bracketInputValue(10, 'distance', { ...context, entry: undefined }), undefined);
  assert(Number.isNaN(bracketInputPrice(10, 'distance', { ...context, entry: undefined })));
  assert.equal(bracketInputValue(1, 'percentage', { ...context, entry: 0 }), undefined);
  assert(Number.isNaN(bracketInputPrice(1, 'percentage', { ...context, entry: 0 })));
  assert.equal(bracketInputPrice(10, 'percentage', { ...context, entry: -10 }), -9);
  assert.equal(bracketInputPrice(-9.999, 'price', context), -9.999);
  assert.equal(bracketInputPrice(undefined, 'price', context), undefined);
  assert.equal(bracketInputValue(99, 'distance', context), -10);
});
test('B01/O08: pip fallback and generated prices respect the effective variable tick', () => {
  const input = { ...context, instrument: { minTick: .01, variableMinTick: '.01 100 .05' } };
  assert.equal(bracketInputPrice(7, 'distance', input), 100.05);
  assert.equal(bracketInputValue(100.05, 'distance', input), 5);
  assert(Number.isNaN(bracketInputPrice(1, 'distance', { ...context, instrument: { minTick: 0 } })));
});

test('B01/P03: account-money protection uses quantity and side pip value and keeps signed wrong-side values visible', () => {
  for (const side of [1, -1]) for (const profit of [true, false]) {
    const input = { ...context, side, profit, quantity: 2, pipValue: 5 };
    const price = 100 + .15 * side * (profit ? 1 : -1);
    assert.equal(bracketInputPrice(15, 'money', input), price);
    assert.equal(bracketInputValue(price, 'money', input), 15);
    assert.equal(bracketInputValue(100 - .15 * side * (profit ? 1 : -1), 'money', input), -15);
  }
  const input = { ...context, entry: 0, quantity: 2, pipValue: 5 };
  assert.equal(bracketInputPrice(15, 'money', input), .15);
  assert.equal(bracketInputValue(.15, 'money', input), 15);
  for (const patch of [{ quantity: 0 }, { quantity: Infinity }, { pipValue: 0 }, { pipValue: NaN }, { instrument: { ...instrument, pipSize: 0 } }]) {
    assert.equal(bracketInputValue(101, 'money', { ...input, ...patch }), undefined);
    assert(Number.isNaN(bracketInputPrice(10, 'money', { ...input, ...patch })));
  }
});

test('B01/P03: instrument-money exits use a known point value and magnifier without an account conversion', () => {
  for (const side of [1, -1]) for (const profit of [true, false]) {
    const input = { ...context, side, profit, quantity: 2, pipValue: 5, accountCurrency: 'USD', moneyCurrency: 'instrument', instrument: { ...instrument, currency: 'EUR', bigPointValue: 50, priceMagnifier: 10 } };
    const price = 100 + side * (profit ? 1 : -1);
    assert.equal(bracketInputPrice(10, 'money', input), price);
    assert.equal(bracketInputValue(price, 'money', input), 10);
    assert.equal(bracketInputValue(100 - side * (profit ? 1 : -1), 'money', input), -10);
    // In identical currencies the authoritative account pip value remains valid.
    assert.equal(bracketInputPrice(100, 'money', { ...input, accountCurrency: 'EUR' }), price);
  }
  const base = { ...context, quantity: 2, pipValue: 5, accountCurrency: 'USD', moneyCurrency: 'instrument', instrument: { ...instrument, currency: 'EUR', bigPointValue: 50, priceMagnifier: 10 } };
  assert.equal(bracketInputPrice(10, 'money', { ...base, pipValue: undefined }), 101);
  for (const change of [{ currency: undefined }, { bigPointValue: undefined }, { bigPointValue: 0 }, { priceMagnifier: 0 }]) {
    const input = { ...base, instrument: { ...base.instrument, ...change } };
    assert.equal(bracketInputValue(101, 'money', input), undefined); assert(Number.isNaN(bracketInputPrice(10, 'money', input)));
  }
});

test('B01/P03: balance-percentage exits always use account equity and pip units, independently of instrument-money mode', () => {
  for (const side of [1, -1]) for (const profit of [true, false]) {
    const input = { ...context, side, profit, quantity: 2, pipValue: 5, equity: 1000, accountCurrency: 'USD', moneyCurrency: 'instrument', instrument: { ...instrument, currency: 'EUR', bigPointValue: 50, priceMagnifier: 10 } };
    const price = 100 + .1 * side * (profit ? 1 : -1);
    assert.equal(bracketInputPrice(1, 'equityPercentage', input), price);
    assert.equal(bracketInputValue(price, 'equityPercentage', input), 1);
    assert.equal(bracketInputPrice(1, 'equityPercentage', { ...input, equity: 2000 }), 100 + .2 * side * (profit ? 1 : -1));
    assert.equal(bracketInputValue(100 - .1 * side * (profit ? 1 : -1), 'equityPercentage', input), -1);
  }
  const input = { ...context, entry: 0, quantity: 2, pipValue: 5, equity: 1000 };
  assert.equal(bracketInputPrice(1, 'equityPercentage', input), .1);
  for (const equity of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(bracketInputValue(.1, 'equityPercentage', { ...input, equity }), undefined);
    assert(Number.isNaN(bracketInputPrice(1, 'equityPercentage', { ...input, equity })));
  }
});
test('B05: unsnapped conversion keeps fractional distances for fields stored as a distance', () => {
  const input = { ...context, profit: false, instrument: { minTick: .01, pipSize: .01 } };
  assert.equal(bracketInputPrice(12.5, 'distance', input), 99.88, 'protective prices snap to the tick by default');
  assert.equal(bracketInputPrice(12.5, 'distance', input, false), 100 - .125);
  assert.equal(bracketInputValue(bracketInputPrice(12.5, 'distance', input, false), 'distance', input), 12.5);
});
test('U03/B05: default exit distances, stop style and stop presence have one spelling', async () => {
  const { bracketStopType, defaultBracketPrice, defaultExitDistance, hasStop } = await loadModule('src/core/bracket-input.ts');
  assert.equal(defaultExitDistance(true), 75); assert.equal(defaultExitDistance(false), 25);
  const instrument = { description: 'X', minTick: 0.01, pipSize: 0.01, pipValue: 1, qty: { min: 1, max: 10, step: 1 } };
  assert.equal(defaultBracketPrice(true, { entry: 100, side: 1, instrument }), 100.75);
  assert.equal(defaultBracketPrice(false, { entry: 100, side: 1, instrument }), 99.75);
  // StopType: StopLoss 0, TrailingStop 1, GuaranteedStop 2.
  assert.equal(bracketStopType({ stopLoss: 1, guaranteedStop: 2, trailingStopPips: 3 }), 1);
  assert.equal(bracketStopType({ stopLoss: 1, guaranteedStop: 2 }), 2);
  assert.equal(bracketStopType({ stopLoss: 1 }), 0);
  assert.equal(bracketStopType({ takeProfit: 1 }), undefined);
  assert.equal(hasStop({ takeProfit: 1 }), false); assert.equal(hasStop({ trailingStopPips: 5 }), true);
});
