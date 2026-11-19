import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { positionProfitCurrency } = await loadModule('src/core/position-profit-currency.ts');

const policy = (inInstrument) => () => ({ flags: { positionPLInInstrumentCurrency: inInstrument } });
const accounts = [{ id: 'A', currency: 'USD' }, { id: 'B', currency: 'EUR' }, { id: 'C' }];
const context = (overrides) => ({ symbolPolicy: policy(false), instrument: { currency: 'USDT' }, accounts, accountId: 'B', ...overrides });

test('position P&L is in the instrument currency when the broker reports it there', () => {
  assert.deepEqual(positionProfitCurrency({ symbol: 'BTCUSDT' }, context({ symbolPolicy: policy(true) })), { source: 'instrument', currency: 'USDT' });
  assert.deepEqual(
    positionProfitCurrency({ symbol: 'BTCUSDT' }, context({ symbolPolicy: policy(true), instrument: undefined })),
    { source: 'instrument', currency: undefined },
    'an unresolved instrument does not fall back to the account currency',
  );
});

test('otherwise position P&L is in the currency of the given account, read from the account list', () => {
  const symbols = [];
  const symbolPolicy = (symbol) => { symbols.push(symbol); return policy(false)(); };
  assert.deepEqual(positionProfitCurrency({ symbol: 'EURUSD' }, context({ symbolPolicy })), { source: 'account', currency: 'EUR' });
  assert.deepEqual(symbols, ['EURUSD'], 'the policy is the position symbol\'s');
});

test('no unit is known without the instrument currency or the account currency', () => {
  assert.deepEqual(positionProfitCurrency({ symbol: 'X' }, context({ accountId: 'C' })), { source: 'account', currency: undefined });
  assert.deepEqual(positionProfitCurrency({ symbol: 'X' }, context({ accountId: 'missing' })), { source: 'account', currency: undefined });
  assert.deepEqual(positionProfitCurrency({ symbol: 'X' }, context({ accounts: undefined })), { source: 'account', currency: undefined });
});
