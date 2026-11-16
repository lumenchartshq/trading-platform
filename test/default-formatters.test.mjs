import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { createNumericFormatter, createPriceFormatter, createDefaultTradingFormatters } = await loadModule('src/compat/default-formatters.ts');
test('U08: standalone numeric formatting handles locale, parsing, changes and non-exponential values', () => {
  const formatter = createNumericFormatter('de-DE', 2);
  assert.equal(formatter.format(1234.5), '1234,50');
  assert.equal(formatter.format(1234.5, { ignoreLocaleNumberFormat: true }), '1234.50');
  assert.deepEqual(formatter.parse('1.234,50'), { res: true, value: 1234.5, suggest: '1234,50' }, 'a successful parse suggests canonical text');
  assert.equal(formatter.parse('12oops').res, false);
  assert.equal(formatter.parse('').res, false);
  assert.equal(formatter.parse('Infinity').res, false);
  assert.equal(formatter.format(-0), '0,00');
  assert.equal(formatter.formatChange(10, 9), '1,00');
  assert(!formatter.format(1e22, { noExponentialForm: true }).includes('e'));
  assert(!formatter.format(1e22, { ignoreLocaleNumberFormat: true, noExponentialForm: true }).includes('e'));
  assert.throws(() => createNumericFormatter('en', 100));
});
test('U08: price formatter preserves fractional examples from pinned symbol declarations', () => {
  const fractional = createPriceFormatter('en', 128, 1, true, 4);
  for (const [fraction, suffix] of [[0, '0'], [0.25, '2'], [0.5, '5'], [0.75, '7']]) {
    const value = 119 + (16 + fraction) / 32, text = `119'16'${suffix}`;
    assert.equal(fractional.format(value), text);
    assert.deepEqual(fractional.parse(text), { res: true, value });
    assert.equal(fractional.format(-value), '-' + text);
  }
  assert.equal(fractional.parse("119'32'0").res, false);
  assert.equal(fractional.parse("119'16'3").res, false);
  const bond = createPriceFormatter('en', 32, 1, true);
  assert.equal(bond.format(133 + 21 / 32), "133'21");
  assert.equal(bond.format(133 + 31.9 / 32), "134'00");
});
test('U08: decimal price controls cover tick alignment, precision, sign and variable schedule', () => {
  const formatter = createPriceFormatter('en', 100, 25);
  assert.equal(formatter.format(12.13), '12.25');
  assert.equal(formatter.format(12.13, { cutFractionalByPrecision: true }), '12.13');
  assert.equal(formatter.format(12.13, { tailSize: 1 }), '12.250');
  assert.equal(formatter.format(12.25, { removeAllEndingZeros: true }), '12.25');
  assert.equal(formatter.format(12, { removeAllEndingZeros: true }), '12');
  assert.equal(formatter.format(12, { signPositive: true }), '+12.00');
  assert.equal(formatter.format(12, { signNegative: true }), '-12.00');
  assert.equal(formatter.formatChange(12.5, 12), '+0.50');
  const variable = createPriceFormatter('en', 100, 1, false, 0, '0.01 10 0.02 25 0.05');
  assert.equal(variable.format(9.999), '10.00');
  assert.equal(variable.format(12.13), '12.14');
  assert.equal(variable.format(30.13), '30.15');
  assert.throws(() => createPriceFormatter('en', 100, 1, false, 0, '0.01 25 0.02 10 0.05'));
});
test('U08: fallback formatter port uses symbol context and honors alignment choice', async () => {
  const port = createDefaultTradingFormatters('en', async () => ({ resolved: true, priceScale: 100, minMove: 25 }));
  assert.equal((await port.defaultPrice('X', false)).format(12.13), '12.13');
  assert.equal((await port.defaultPrice('X', true)).format(12.13), '12.25');
  assert.equal((await port.quantity()).format(2.5), '2.5');
  assert.equal((await port.quantity(2)).format(2.5), '2.50');
  await assert.rejects(createDefaultTradingFormatters('en', async () => ({ resolved: false })).defaultPrice('X', true), /precision/);
});
