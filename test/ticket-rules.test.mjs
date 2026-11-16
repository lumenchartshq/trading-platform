import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { locked, bracketsAllowed, riskAllowed, phaseText, submitAction, priceSuffix } = await loadModule('src/ui/order-ticket/rules.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const base = resolveCapabilities({ configFlags: { supportOrderBrackets: true, supportMarketBrackets: true, supportStopLoss: true } });
const order = { symbol: 'X', side: 1, type: 1, qty: 2, limitPrice: 100 };
const instrument = { type: 'stock', pipValue: 1 };
const policy = (flags = {}, symbol = {}) => ({ ...base, flags: { ...base.flags, ...flags }, symbol });

test('B01/U01: ticket bracket and risk rules preserve market, crypto, symbol and instrument restrictions', () => {
  assert(bracketsAllowed(base, order, 'stock'));
  assert(!bracketsAllowed(policy({ supportMarketBrackets: false }), { ...order, type: 2 }, 'stock'));
  assert(!bracketsAllowed(policy({ supportCryptoExchangeOrderTicket: true, supportCryptoBrackets: false }), order, 'crypto'));
  assert(riskAllowed(base, order, instrument, true));
  for (const [p, o, i, information] of [
    [base, order, instrument, false],
    [policy({}, { supportRiskControlsAndInfo: false }), order, instrument, true],
    [base, { ...order, exitLevels: [{ qty: 1 }] }, instrument, true],
    [base, order, { ...instrument, pipValue: 0 }, true],
    [policy({ supportStopLoss: false, supportGuaranteedStop: false }), order, instrument, true],
  ]) assert.equal(riskAllowed(p, o, i, information), false);
});

test('O03/U04: new orders remain unlocked while missing modification permissions lock existing orders', () => {
  for (const field of ['price', 'qty', 'type', 'duration', 'brackets']) {
    assert.equal(locked(false, undefined, field), false);
    assert.equal(locked(true, undefined, field), true);
    assert.equal(locked(true, { [field]: true }, field), false);
  }
});

test('U04: ticket review labels, phase copy and order price suffix retain their precedence', () => {
  assert.equal(submitAction(false, false, false), 'Place order');
  assert.equal(submitAction(false, false, true), 'Modify order');
  assert.equal(submitAction(true, false, true), 'Review order');
  assert.equal(submitAction(false, true, false), 'Review order');
  assert.equal(phaseText('confirmed', false), '');
  assert.equal(phaseText('confirmed', true), 'The broker confirmed the result.');
  assert.match(phaseText('unconfirmed', false), /could not confirm.*Check your orders/);
  assert.match(phaseText('unconfirmed', false, true), /Checking with the broker/);
  assert.equal(phaseText('sending', false), 'Waiting for the broker to confirm…');
  assert.equal(phaseText('sending', false, false, true), 'Sent to the broker. Waiting for confirmation…');
  assert.equal(phaseText('editing', false), '');
  assert.equal(priceSuffix({ ...order, type: 4, stopPrice: 101 }, String), ' @ 100');
  assert.equal(priceSuffix({ ...order, type: 3, stopPrice: 101 }, String), ' @ 101');
  assert.equal(priceSuffix({ ...order, limitPrice: undefined }, String), '');
});
