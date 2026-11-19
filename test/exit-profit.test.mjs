import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { exitProfitText, exitTooltip, profitTickUnit } = await loadModule('src/chart/exit-profit.ts');

const instrument = { qty: { min: 1, max: 100, step: 1 }, pipValue: 1, pipSize: 0.01, minTick: 0.01, description: '', currency: 'JPY' };
const input = (display, overrides = {}) => ({
  instrument, side: 1, qty: 2, entry: 100, exit: 101,
  // Brackets have their own unit; the position unit deliberately differs to prove it is not used.
  display: { showPositionProfit: true, positionProfitDisplay: display === 'money' ? 'ticks' : 'money', bracketProfitDisplay: display }, currency: { source: 'account', currency: 'USD' }, ...overrides,
});
const inInstrument = (currency) => ({ currency: { source: 'instrument', currency } });

test('P02/P03: broker and draft exit pills share one unit vocabulary', () => {
  assert.equal(exitProfitText(input('percentage')), '+1.00%');
  assert.equal(exitProfitText(input('ticks')), '+100.00 ticks');
  assert.equal(exitProfitText(input('ticks', { instrument: { ...instrument, pipSize: 0.1 } })), '+10.00 pips');
  assert.equal(exitProfitText(input('money')), '+200.00 USD', '100 pips at 1 USD per pip on 2 units');
  assert.equal(exitProfitText(input('money', { ...inInstrument('JPY'), instrument: { ...instrument, bigPointValue: 10 } })), '+20.00 JPY');
  assert.equal(exitProfitText(input('money', { side: -1 })), '-200.00 USD');
});

test('P02/P03: exit pills hide unavailable estimates instead of inventing units', () => {
  assert.equal(exitProfitText(input('money', { currency: { source: 'account', currency: undefined } })), undefined);
  assert.equal(exitProfitText(input('money', { entry: undefined })), undefined);
  assert.equal(exitProfitText(input('money', { instrument: undefined })), undefined);
  assert.equal(exitProfitText({ ...input('money'), display: { showPositionProfit: true, positionProfitDisplay: 'money', showBracketProfit: false } }), undefined);
  assert.equal(exitProfitText({ ...input('money'), display: { showPositionProfit: true, positionProfitDisplay: 'money', showProfit: false } }), undefined, 'the parent P&L switch hides brackets too');
  assert.equal(exitProfitText({ ...input('money'), display: { showPositionProfit: false, positionProfitDisplay: 'money' } }), '+200.00 USD', 'hiding position P&L leaves brackets visible');
  assert.equal(profitTickUnit({ minTick: 0.01 }), 'ticks', 'missing pip size counts ticks');
});

test('OC08: a confirmed exit tooltip shows its profit-signed move in percent and ticks, then its price', () => {
  const crypto = { pipSize: 0.001, minTick: 0.001 };
  assert.equal(
    exitTooltip({ field: 'takeProfit', side: 1, entry: 3943.28, exit: 4000.726, instrument: crypto }),
    'Take Profit +1.46% +57,446 ticks\nPrice 4,000.726',
  );
  assert.equal(
    exitTooltip({ field: 'stopLoss', side: 1, entry: 3943.28, exit: 3870.317, instrument: crypto }),
    'Stop Loss -1.85% -72,963 ticks\nPrice 3,870.317',
  );
  assert.equal(
    exitTooltip({ field: 'takeProfit', side: -1, entry: 1.1, exit: 1.095, instrument: { pipSize: 0.0001, minTick: 0.00001 } }),
    'Take Profit +0.45% +50.0 pips\nPrice 1.09500',
    'a short TP below entry is still a gain; pip instruments count pips',
  );
  assert.equal(exitTooltip({ field: 'stopLoss', side: 1, entry: undefined, exit: 1, instrument: crypto }), undefined);
});

test('P02: instrument-currency exits need a point value; a linear USDT perpetual uses 1', () => {
  const perpetual = { qty: { min: 0.001, max: 100, step: 0.001 }, pipValue: 0.1, pipSize: 0.1, minTick: 0.1, description: '', currency: 'USDT', type: 'futures' };
  const exit = (overrides) => exitProfitText(input('money', { instrument: perpetual, ...inInstrument('USDT'), qty: 0.001, entry: 75990.8, ...overrides }));
  assert.equal(exit({ exit: 76417.8 }), undefined, 'futures without a point value cannot be estimated');
  assert.equal(exit({ instrument: { ...perpetual, bigPointValue: 1 }, exit: 76417.8 }), '+0.43 USDT');
  assert.equal(exit({ instrument: { ...perpetual, bigPointValue: 1 }, exit: 75532.7 }), '-0.46 USDT');
});
