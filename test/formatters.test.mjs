import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { formatStandard, columnValues } = await loadModule('src/compat/formatters.ts');
const fixed = { format: n => n.toFixed(2) };
const context = { numeric: fixed, integer: { format: n => String(n) }, variable: { format: n => String(n) }, quantity: { format: n => String(n) }, price: { format: n => n.toFixed(4) }, accountCurrency: 'USD', instrumentType: 'forex', locale: 'en-GB', timezone: 'Asia/Kuala_Lumpur' };

test('U06: complete built-in formatter matrix produces text and semantic decoration', () => {
  const cases = [
    [undefined, ['A', 'B'], 'A B'], ['default', [12, 'USD'], '12 USD'], ['text', ['<script>'], '<script>'], ['empty', ['X'], ''],
    ['fixed', [12], '12.00'], ['variablePrecision', [12.123], '12.123'], ['fixedInCurrency', [12, 'EUR'], '12.00 EUR'],
    ['formatQuantity', [12.5], '12.5'], ['integerSeparated', [12.6], '13'], ['formatPrice', [1.25], '1.2500'],
    ['formatPriceForexSup', [1.25], '1.2500'], ['formatPriceInCurrency', [1.25, 'EUR'], '1.2500 EUR'],
    ['side', [-1], 'Sell'], ['positionSide', [1], 'Long'], ['status', [6], 'Working'], ['type', [4], 'Stop-limit'],
    ['symbol', ['Display', 'BROKER:X'], 'Display'], ['pips', [4.5], '4.5 pips'], ['percentage', [5], '5.00%'],
    ['profitInPercent', [5], '5.00%'], ['coloredPercentage', [3], '3.00%'], ['marginPercent', [Infinity], '> 200%'],
    ['profit', [12], '+12.00 USD'], ['profitInInstrumentCurrency', [-12, 'EUR'], '-12.00 EUR'],
    ['profitInInstrumentCurrencyFloored', [12.129, 'EUR'], '+12.12 EUR'], ['formatExitLevels', [12, [], 1], '12.0000'],
  ];
  for (const [name, values, expected] of cases) assert.equal(formatStandard(name, values, context).text, expected, name);
  for (const name of ['date', 'localDate', 'dateOrDateTime', 'localDateOrDateTime']) {
    const value = name.toLowerCase().includes('ordatetime') ? { dateOrDateTime: 1704067200000, hasTime: false } : 1704067200000;
    assert.match(formatStandard(name, [value], context).text, /01\/01\/2024/);
  }
  assert.equal(formatStandard('formatPriceForexSup', [1], context).superscriptLast, true);
  assert.equal(formatStandard('profit', [-1], context).tone, 'negative');
  assert.equal(formatStandard('coloredPercentage', [3], context).tone, 'warning');
  assert.equal(formatStandard('marginPercent', [0.005], context).text, '0.005%');
  assert.equal(formatStandard('fixed', [undefined], context).text, '');
});
test('U06/E2: pinned showZeroValues=true hides zero; explicit false displays it', () => {
  assert.equal(formatStandard('fixed', [0], context).text, '');
  assert.equal(formatStandard('fixed', [0], context, false).text, '0.00');
});
test('U06: nested fields, empty dependency list, exit-level leg and formatter exceptions', () => {
  const row = { extra: { balance: 20 }, symbol: 'BROKER:X' };
  assert.deepEqual(columnValues(row, [['extra', 'balance'], 'symbol']), [20, 'BROKER:X']);
  assert.deepEqual(columnValues(row, []), [row]);
  assert.deepEqual(columnValues(row, ['toString']), [undefined]);
  assert.equal(formatStandard('formatExitLevels', [undefined, [{ takeProfit: 10 }, { takeProfit: 20 }], 2], { ...context, exitLevelLeg: 'takeProfit' }).text, '10.0000, 20.0000');
  assert.throws(() => formatStandard('formatPrice', [1], { ...context, price: { format: () => { throw new Error('provider formatter'); } } }), /provider formatter/);
});
test('U06: symbol formatter base and withMessage forms, and the symbol-name preference', () => {
  assert.deepEqual(formatStandard('symbol', ['', 'BROKER:X'], context), { text: 'BROKER:X' });
  assert.deepEqual(formatStandard('symbol', ['', 'BROKER:X'], { ...context, preferSymbolName: true }), { text: 'X' });
  assert.deepEqual(formatStandard('symbol', ['Display', 'BROKER:X', 'Trading halted'], context), { text: 'Display', message: 'Trading halted', tone: 'warning' });
  assert.deepEqual(formatStandard('symbol', ['Display', 'BROKER:X', ''], context), { text: 'Display' }, 'an empty message adds nothing');
});
test('U06: exit-level formatter base and withLevels forms', () => {
  assert.equal(formatStandard('formatExitLevels', [12.5], context).text, '12.5000', 'base form: the legacy price');
  assert.equal(formatStandard('formatExitLevels', [undefined, [{ stopLoss: 9 }, { stopLoss: 8 }], 4], { ...context, exitLevelLeg: 'stopLoss' }).text, '9.0000, 8.0000', 'withLevels form: price, levels and quantity');
});
