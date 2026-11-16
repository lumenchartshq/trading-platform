import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { normalizeTradability, assertTradable } = await loadModule('src/core/tradability.ts');
test('O03/U05: tradability accepts boolean and object forms, bounds text and keeps only safe solutions', () => {
  assert.deepEqual(normalizeTradability(true), { tradable: true });
  assert.deepEqual(normalizeTradability({ tradable: false, reason: 'Market closed', reasonHeading: 'Unavailable', shortReason: 'Closed', confirmButtonText: 'Got it' }),
    { tradable: false, reason: 'Market closed', heading: 'Unavailable', shortReason: 'Closed', buttonText: 'Got it' });
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { changeAccount: 'B' } }).solution, { kind: 'account', accountId: 'B' });
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { changeSymbol: 'SIM:Y' } }).solution, { kind: 'symbol', symbol: 'SIM:Y' });
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { openUrl: { url: 'https://example.test/kyc', text: 'Verify' } } }).solution, { kind: 'url', url: 'https://example.test/kyc', text: 'Verify' });
  assert.equal(normalizeTradability({ tradable: false, solutions: { openUrl: { url: 'javascript:alert(1)', text: 'x' } } }).solution, undefined);
  assert.equal(normalizeTradability({ tradable: false, reason: 'x'.repeat(900) }).reason.length, 300);
  assert.throws(() => normalizeTradability({ reason: 'missing flag' }), { code: 'configuration' });
  assert.throws(() => assertTradable({ tradable: false, reason: 'Market closed' }), /Market closed/);
  assert.throws(() => assertTradable(false), /unavailable for trading/);
});
