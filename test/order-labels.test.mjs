import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { orderTypeName, sideName, orderDisplayPrice } = await loadModule('src/core/order-labels.ts');
const { placesOrdersWithoutTicket, editsPositionsWithoutDialog, ticketSkipsReview } = await loadModule('src/core/review-policy.ts');
const { showsIndividualPositions } = await loadModule('src/core/capabilities.ts');
const { entityEntryPrice } = await loadModule('src/core/financial-rules.ts');

test('U02: ticket, chart lines, dialogs and notifications share order wording', () => {
  assert.deepEqual([1, 2, 3, 4].map(orderTypeName), ['Limit', 'Market', 'Stop', 'Stop-limit']);
  assert.equal(sideName(1), 'Buy'); assert.equal(sideName(-1), 'Sell');
  assert.equal(orderDisplayPrice({ type: 4, limitPrice: 10, stopPrice: 11 }), 10);
  assert.equal(orderDisplayPrice({ type: 3, limitPrice: 10, stopPrice: 11 }), 11);
});

test('U04/O03: silent placement, forced confirmation and custom dialogs decide direct chart actions', () => {
  const session = (silent, overrides = {}) => ({
    host: { silentOrdersPlacement: () => ({ value: () => silent }) },
    confirmationRequired: false, hasCustomOrderDialog: false, hasCustomPositionDialog: false,
    ticketSettings: { get: () => ({ showOrderPreview: false }) },
    symbolPolicy: () => ({ flags: { supportPlaceOrderPreview: true, supportModifyOrderPreview: false } }), ...overrides,
  });
  assert.equal(placesOrdersWithoutTicket(session(true)), true);
  assert.equal(placesOrdersWithoutTicket(session(false)), false);
  assert.equal(placesOrdersWithoutTicket(session(true, { confirmationRequired: true })), false);
  assert.equal(placesOrdersWithoutTicket(session(true, { hasCustomOrderDialog: true })), false);
  assert.equal(editsPositionsWithoutDialog(session(true, { hasCustomOrderDialog: true })), true);
  assert.equal(editsPositionsWithoutDialog(session(true, { hasCustomPositionDialog: true })), false);
  const previewOn = { ticketSettings: { get: () => ({ showOrderPreview: true }) } };
  assert.equal(ticketSkipsReview(session(false), 'X', false), true);
  assert.equal(ticketSkipsReview(session(false, previewOn), 'X', false), false, 'a previewing broker keeps the review');
  assert.equal(ticketSkipsReview(session(false, previewOn), 'X', true), true, 'without modify previews a modification sends directly');
  const noPreview = { ...previewOn, symbolPolicy: () => ({ flags: {} }) };
  assert.equal(ticketSkipsReview(session(false, noPreview), 'X', false), true, 'the preference has no effect without broker previews');
  assert.equal(ticketSkipsReview(session(false, { ...noPreview, confirmationRequired: true }), 'X', false), false, 'forced confirmation still reviews');
});

test('C01/B06: individual rows replace net rows only for netting brokers without net brackets', () => {
  assert.equal(showsIndividualPositions({ supportPositionNetting: true, supportIndividualPositionBrackets: true, supportPositionBrackets: false }), true);
  assert.equal(showsIndividualPositions({ supportPositionNetting: true, supportIndividualPositionBrackets: true, supportPositionBrackets: true }), false);
  assert.equal(entityEntryPrice('position', { avgPrice: 5 }), 5);
  assert.equal(entityEntryPrice('individualPosition', { price: 6 }), 6);
  assert.equal(entityEntryPrice('order', { type: 1, side: 1, limitPrice: 7 }), 7);
});
