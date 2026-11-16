import { simulatedSession } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred, flush } from './manual-clock.mjs';
async function fixture(flags = {}, configure) {
  const f = await simulatedSession({ flags, configureBroker: configure });
  return { ...f, request(leverage = 20) {
    return { context: f.session.commands.context(), params: { symbol: 'SIM:X', orderType: 1, side: 1, leverage } };
  } };
}
test('P04: leverage confirms through a fresh broker read, invalidates order preview and refreshes metadata/demand', async () => {
  const f = await fixture({ supportPlaceOrderPreview: true });
  try {
    const margin = f.session.acquireFinancial('margin', 'SIM:X'), pip = f.session.acquireFinancial('pip', 'SIM:X');
    const instrument = await f.session.symbolInfo('SIM:X'); assert.equal(instrument.marginRate, 0.1);
    const order = { context: f.session.commands.context(), order: { symbol: 'SIM:X', side: 1, type: 1, qty: 2, limitPrice: 100 } };
    const orderReview = await f.session.commands.preview(order), request = f.request(), review = await f.session.commands.previewLeverage(request);
    const result = await f.session.commands.setLeverage({ ...request, previewToken: review.token });
    assert.equal(result.outcome, 'confirmed');
    assert.equal((await f.session.symbolInfo('SIM:X')).marginRate, 0.05);
    assert.equal((await f.session.commands.leverageInfo(request)).leverage, 20);
    for (const call of f.simulation.controls.calls().filter(call => call.method === 'leverageInfo')) assert.equal(call.args[0].leverage, undefined);
    await assert.rejects(f.session.commands.place({ ...order, previewToken: orderReview.token, confirmId: orderReview.preview.confirmId }), /Review the current order/);
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 1);
    assert.equal(f.simulation.controls.subscriptionCounts().margin, 1); assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
    margin(); pip();
  } finally { f.session.destroy(); }
});
test('P04/U01: disabled leverage or button never invokes an unsupported change', async () => {
  const disabled = await fixture({ supportLeverage: false });
  await assert.rejects(disabled.session.commands.leverageInfo(disabled.request()), error => error.code === 'unsupported');
  assert.equal(disabled.simulation.controls.calls().filter(call => call.method === 'leverageInfo').length, 0); disabled.session.destroy();
  const hidden = await fixture({ supportLeverageButton: false });
  assert.equal((await hidden.session.commands.leverageInfo(hidden.request())).leverage, 10);
  await assert.rejects(hidden.session.commands.previewLeverage(hidden.request()), error => error.code === 'unsupported'); hidden.session.destroy();
});
test('P04/U04: broker errors and mismatched or reused preview tokens never dispatch twice', async () => {
  const blocked = await fixture({}, broker => { broker.previewLeverage = async () => ({ errors: ['Unavailable'] }); });
  const request = blocked.request(), review = await blocked.session.commands.previewLeverage(request);
  await assert.rejects(blocked.session.commands.setLeverage({ ...request, previewToken: review.token }), /Review the current leverage/);
  assert.equal(blocked.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 0); blocked.session.destroy();
  const f = await fixture();
  try {
    const request = f.request(), review = await f.session.commands.previewLeverage(request);
    await assert.rejects(f.session.commands.setLeverage({ ...f.request(30), previewToken: review.token }), /Review the current leverage/);
    const results = await Promise.allSettled([f.session.commands.setLeverage({ ...request, previewToken: review.token }), f.session.commands.setLeverage({ ...request, previewToken: review.token })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 1);
  } finally { f.session.destroy(); }
});
test('P04/A03: account changes fence delayed leverage previews', async () => {
  const pending = deferred(), f = await fixture({}, broker => { broker.previewLeverage = () => pending.promise; });
  try {
    const preview = f.session.commands.previewLeverage(f.request()); await flush();
    await f.session.commands.selectAccount('simulation-B'); pending.resolve({ infos: ['Old account'] });
    await assert.rejects(preview, error => error.code === 'stale-context');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 0);
  } finally { f.session.destroy(); }
});
test('P04/O05: delayed leverage acknowledgement becomes unconfirmed without resend and later reconciles', async () => {
  const f = await fixture();
  try {
    const request = f.request(), review = await f.session.commands.previewLeverage(request);
    f.simulation.controls.delayNextAcknowledgement(20000);
    const setting = f.session.commands.setLeverage({ ...request, previewToken: review.token }); await flush();
    f.simulation.clock.advance(10000); assert.equal((await setting).outcome, 'unconfirmed'); await flush();
    // Follow-up reconciliation reads run while the acknowledgement is late, so time advances as it would live.
    for (let second = 0; second < 10; second++) { f.simulation.clock.advance(1000); await flush(); await flush(); }
    assert.equal(f.session.pending.get(f.session.pending.ids().at(-1)).stage, 'confirmed');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 1);
  } finally { f.session.destroy(); }
});
test('P04: decimal leverage steps use the broker minimum as their origin and optional preview stays absent', async () => {
  let value = 1.05;
  const f = await fixture({}, broker => {
    const info = broker.symbolInfo;
    broker.symbolInfo = async symbol => ({ ...await info(symbol), leverage: String(value), marginRate: 1 / value });
    broker.leverageInfo = async () => ({ title: 'Leverage', leverage: value, min: 1.05, max: 2, step: 0.1 });
    delete broker.previewLeverage;
    broker.setLeverage = async params => { value = params.leverage; return { leverage: value }; };
  });
  try {
    const request = f.request(1.15), review = await f.session.commands.previewLeverage(request);
    assert.equal(review.preview, undefined);
    assert.equal((await f.session.commands.setLeverage({ ...request, previewToken: review.token })).outcome, 'confirmed');
    assert.equal((await f.session.symbolInfo('SIM:X')).leverage, '1.15');
    await assert.rejects(f.session.commands.previewLeverage(f.request(1.2)), /broker limits and step/);
  } finally { f.session.destroy(); }
});
test('P04: a failed confirmation read after the broker accepted leverage is unconfirmed, not rejected', async () => {
  let failInfo = false, refreshes = 0;
  const f = await fixture({}, broker => {
    const info = broker.leverageInfo.bind(broker);
    broker.leverageInfo = params => failInfo ? Promise.reject(new Error('read failed')) : info(params);
    const setLeverage = broker.setLeverage.bind(broker);
    broker.setLeverage = async params => { const result = await setLeverage(params); failInfo = true; return result; };
    const orders = broker.orders.bind(broker);
    broker.orders = () => { refreshes++; return orders(); };
  });
  try {
    const request = f.request(), review = await f.session.commands.previewLeverage(request);
    const before = refreshes;
    const setting = f.session.commands.setLeverage({ ...request, previewToken: review.token });
    // Let the read fail, then pass the confirmation deadline.
    await flush(); await flush();
    f.simulation.clock.advance(10000);
    const result = await setting;
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 1);
    await flush();
    assert.equal(refreshes - before, 1, 'one refresh at the deadline');
  } finally { f.session.destroy(); }
});
test('P04: a slow metadata refresh after a leverage change does not hold up its confirmation', async () => {
  let stall = false;
  const f = await fixture({}, broker => {
    const info = broker.symbolInfo.bind(broker);
    broker.symbolInfo = symbol => stall ? new Promise(() => {}) : info(symbol);
    const setLeverage = broker.setLeverage.bind(broker);
    broker.setLeverage = async params => { const result = await setLeverage(params); stall = true; return result; };
  });
  try {
    const request = f.request(), review = await f.session.commands.previewLeverage(request);
    const setting = f.session.commands.setLeverage({ ...request, previewToken: review.token });
    let outcome;
    void setting.then(result => { outcome = result.outcome; });
    for (let i = 0; i < 20 && !outcome; i++) await flush();
    assert.equal(outcome, 'confirmed', 'confirmed from the leverage read alone');
  } finally { f.session.destroy(); }
});
test('P04/O03: leverage reconciliation retries a failed confirmation read without resending the change', async () => {
  let failInfo = false;
  const f = await fixture({}, broker => {
    const info = broker.leverageInfo.bind(broker);
    broker.leverageInfo = params => failInfo ? Promise.reject(new Error('temporary read failure')) : info(params);
    const setLeverage = broker.setLeverage.bind(broker);
    broker.setLeverage = async params => { const result = await setLeverage(params); failInfo = true; return result; };
  });
  try {
    const request = f.request(), review = await f.session.commands.previewLeverage(request);
    const setting = f.session.commands.setLeverage({ ...request, previewToken: review.token });
    await flush(); await flush();
    f.simulation.clock.advance(10000);
    const result = await setting;
    assert.equal(result.outcome, 'unconfirmed');
    await flush(); await flush();
    failInfo = false;
    f.simulation.clock.advance(2000);
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(f.session.pending.get(result.commandId).stage, 'confirmed');
    assert.equal(f.session.pending.get(result.commandId).reconciling, false);
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'setLeverage').length, 1);
  } finally { f.session.destroy(); }
});
