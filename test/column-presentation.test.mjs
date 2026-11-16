import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { columnTooltip, columnPriceTone } = await loadModule('src/ui/account-manager/column-presentation.ts');
test('U06: column tooltip maps follow owned flat/nested input fields and ignore malformed values', () => {
  const column = { id: 'price', label: 'Price', dataFields: ['limitPrice', ['extra', 'price']], tooltipProperty: 'tips' };
  assert.equal(columnTooltip({ tips: { limitPrice: '<b>Broker price</b>', extra: { price: 'Other price' } } }, column), '<b>Broker price</b>\nOther price');
  assert.equal(columnTooltip({ tips: { 'extra.price': 'Nested price' } }, column), 'Nested price');
  assert.equal(columnTooltip({ tips: { limitPrice: 'Same', extra: { price: 'Same' } } }, column), 'Same');
  for (const tips of [undefined, null, 'not a map', [], { limitPrice: 42 }, Object.create({ limitPrice: 'inherited' })]) assert.equal(columnTooltip({ tips }, column), undefined);
  assert.equal(columnTooltip({ tips: { limitPrice: 'Hidden' } }, { ...column, tooltipProperty: undefined }), undefined);
});
test('U06: standard price highlighting has explicit opt-in and finite directional comparisons', () => {
  for (const formatter of ['formatPrice', 'formatPriceForexSup']) {
    const column = { id: 'price', label: 'Price', dataFields: ['price'], formatter, highlightDiff: true };
    assert.equal(columnPriceTone(column, [101], [100]), 'positive');
    assert.equal(columnPriceTone(column, [99], [100]), 'negative');
    for (const [current, previous] of [[100, 100], [Infinity, 1], [1, NaN], ['2', 1], [undefined, 1], [1, undefined]]) assert.equal(columnPriceTone(column, [current], [previous]), undefined);
    assert.equal(columnPriceTone({ ...column, highlightDiff: false }, [2], [1]), undefined);
    assert.equal(columnPriceTone(column, [2]), undefined);
    assert.equal(columnPriceTone({ ...column, formatter: 'custom' }, [2], [1]), undefined);
  }
});
