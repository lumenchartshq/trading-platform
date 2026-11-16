import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { mapSettings, simulatedSession } from './support/session-fixture.mjs';
const settings = await loadModule('src/core/trading-settings.ts');
const { NotificationType } = await loadModule('src/contracts/broker.ts');

const fieldIds = snapshot => snapshot.sections.flatMap(section => section.fields.flatMap(field => [field.id, ...(field.select ? [field.select.id] : [])]));

test('U08: the trading page follows the reference layout and reports effective defaults', async () => {
  const { session } = await simulatedSession({ flags: { supportMultipleExitLevels: false } });
  const snapshot = settings.tradingSettingsSnapshot(session);
  assert.deepEqual(snapshot.sections.map(section => section.title), ['General', 'Appearance']);
  assert.deepEqual(fieldIds(snapshot), [
    'buySellButtons', 'oneClickTrading', 'executionSound', 'rejectionNotificationsOnly',
    'positionsAndOrders', 'showReverse', 'showProfit', 'showPositionProfit', 'positionProfitDisplay',
    'showBracketProfit', 'bracketProfitDisplay', 'showExecutions', 'showExecutionLabels', 'extendLines', 'lineAlignment',
  ]);
  assert.deepEqual(snapshot.values, {
    buySellButtons: true, oneClickTrading: false, executionSound: false, rejectionNotificationsOnly: false,
    positionsAndOrders: true, showReverse: true, showProfit: true, showPositionProfit: true, positionProfitDisplay: 'money',
    showBracketProfit: true, bracketProfitDisplay: 'money', showExecutions: true, showExecutionLabels: false,
    extendLines: true, lineAlignment: 'right',
  });
  assert(Object.isFrozen(snapshot.values));
  session.destroy();
});

test('U08: broker flags decide optional rows and confirmation-required brokers cannot enable one-click trading', async () => {
  const { session } = await simulatedSession({ flags: { supportMultipleExitLevels: true }, options: { requireConfirmation: true } });
  const snapshot = settings.tradingSettingsSnapshot(session);
  assert(fieldIds(snapshot).includes('multipleExitLevels'));
  const oneClick = snapshot.sections[0].fields.find(field => field.id === 'oneClickTrading');
  assert.equal(oneClick.disabled, true);
  assert.throws(() => settings.applyTradingSettings(session, { oneClickTrading: true }), { code: 'invalid-input' });
  assert.equal(session.host.silentOrdersPlacement().value(), false);
  session.destroy();
});

test('U08: applying routes each field to its owner and validates the whole patch before writing', async () => {
  const values = new Map();
  const { session } = await simulatedSession({ flags: { supportMultipleExitLevels: false }, options: { settings: mapSettings(values), settingsKey: 'S' } });
  for (const patch of [{ unknown: true }, { multipleExitLevels: true }, { showReverse: 'yes' }, { positionProfitDisplay: 'pips' }, { lineAlignment: 'top' }, null, []])
    assert.throws(() => settings.applyTradingSettings(session, patch), { code: 'invalid-input' });
  assert.throws(() => settings.applyTradingSettings(session, { showReverse: false, lineAlignment: 'top' }), { code: 'invalid-input' });
  assert.equal(settings.effectiveDisplay(session.displaySettings.get()).showReverse, true, 'nothing is written when one field is invalid');
  let notified = 0;
  const release = settings.subscribeTradingSettings(session, () => notified++);
  settings.applyTradingSettings(session, {
    buySellButtons: false, oneClickTrading: true, positionsAndOrders: false, showBracketProfit: false,
    bracketProfitDisplay: 'ticks', lineAlignment: 'center', showExecutionLabels: true, rejectionNotificationsOnly: true,
  });
  const display = settings.effectiveDisplay(session.displaySettings.get());
  assert.equal(display.showPositions, false); assert.equal(display.showOrders, false);
  assert.equal(display.showBracketProfit, false); assert.equal(display.bracketProfitDisplay, 'ticks');
  assert.equal(display.lineAlignment, 'center'); assert.equal(display.showExecutionLabels, true);
  assert.equal(session.host.sellBuyButtonsVisibility().value(), false);
  assert.equal(session.host.silentOrdersPlacement().value(), true);
  assert(notified >= 3, 'display and both host values notify the page');
  assert.equal(display.showBuySellButtons, false, 'the Buy/sell choice is saved as a display setting');
  const restored = (await simulatedSession({ options: { settings: mapSettings(values), settingsKey: 'S' } })).session;
  assert.equal(restored.host.sellBuyButtonsVisibility().value(), false, 'the saved choice is restored at startup');
  restored.host.sellBuyButtonsVisibility().setValue(true);
  assert.equal(settings.effectiveDisplay(restored.displaySettings.get()).showBuySellButtons, false, 'a broker change is not saved as the user choice');
  restored.destroy();
  release();
  const before = notified;
  settings.applyTradingSettings(session, { showReverse: false });
  assert.equal(notified, before, 'released listeners are not called');
  session.destroy();
});

test('U08: retrying one-click trading persists a live value after storage recovers', async () => {
  const values = new Map();
  let fail = false;
  const storage = mapSettings(values);
  const { session } = await simulatedSession({ options: { settings: {
    ...storage,
    set(key, value) {
      if (fail && key.includes('silentOrdersPlacement')) throw new Error('Storage unavailable');
      storage.set(key, value);
    },
  }, settingsKey: 'retry' } });
  fail = true;
  assert.throws(() => settings.applyTradingSettings(session, { oneClickTrading: true }), /Storage unavailable/);
  assert.equal(session.host.silentOrdersPlacement().value(), true);
  fail = false;
  settings.applyTradingSettings(session, { oneClickTrading: true });
  const restored = (await simulatedSession({ options: { settings: storage, settingsKey: 'retry' } })).session;
  assert.equal(restored.host.silentOrdersPlacement().value(), true);
  restored.destroy();
  session.destroy();
});

test('U08/P02: parent switches and notification filters use the effective values', () => {
  const base = { positionProfitDisplay: 'money', showPositionProfit: true };
  assert.equal(settings.positionProfitVisible(base), true);
  assert.equal(settings.positionProfitVisible({ ...base, showProfit: false }), false);
  assert.equal(settings.bracketProfitVisible({ ...base, showBracketProfit: false }), false);
  assert.equal(settings.bracketProfitVisible({ ...base, showProfit: false }), false);
  assert.equal(settings.bracketProfitMode({ ...base, positionProfitDisplay: 'ticks' }), 'money', 'brackets keep their own unit');
  assert.equal(settings.showsToast(NotificationType.Success, base), true);
  assert.equal(settings.showsToast(NotificationType.Success, { ...base, rejectionNotificationsOnly: true }), false);
  assert.equal(settings.showsToast(NotificationType.Error, { ...base, rejectionNotificationsOnly: true }), true);
});

test('U08: showTradingProperties opens the host settings page and falls back to the platform dialog', async () => {
  const { session } = await simulatedSession();
  const opened = [];
  let accept = true;
  const release = session.setSettingsOpener(() => { opened.push('page'); return accept; });
  session.host.showTradingProperties();
  assert.deepEqual(opened, ['page']);
  assert.equal(session.dialogs.current.get(), undefined, 'the host page replaces the dialog');
  accept = false;
  session.host.showTradingProperties();
  assert.equal(session.dialogs.current.get()?.request.kind, 'properties', 'a host that cannot open falls back');
  session.dialogs.respond(session.dialogs.current.get().id, true);
  const replaced = session.setSettingsOpener(() => { throw new Error('closed'); });
  release();
  session.host.showTradingProperties();
  assert.equal(session.dialogs.current.get()?.request.kind, 'properties', 'a failing opener falls back, and a stale release keeps the newer opener');
  replaced();
  session.destroy();
});

test('U08: confirmed fills play the execution sound only when enabled, including with toasts turned off', async () => {
  const { OrderStatus, OrderType, Side } = await loadModule('src/contracts/broker.ts');
  const played = [];
  const sound = { playExecution: () => played.push('fill') };
  for (const disabledFeatures of [[], ['trading_notifications', 'show_trading_notifications_history']]) {
    played.length = 0;
    const { session } = await simulatedSession({ options: { sound, disabledFeatures } });
    await session.ready;
    const order = { id: 'S1', symbol: 'SIM:X', side: Side.Buy, qty: 1, type: OrderType.Market, status: OrderStatus.Working };
    session.host.orderUpdate(order);
    session.host.orderUpdate({ ...order, status: OrderStatus.Filled });
    assert.deepEqual(played, [], 'the sound is off by default');
    session.updateDisplaySettings({ executionSound: true });
    session.host.orderUpdate({ ...order, id: 'S2' });
    session.host.orderUpdate({ ...order, id: 'S2', status: OrderStatus.Filled });
    session.host.orderUpdate({ ...order, id: 'S3', status: OrderStatus.Cancelled ?? OrderStatus.Canceled });
    assert.deepEqual(played, ['fill'], `one sound for one fill (${disabledFeatures.length ? 'toasts off' : 'toasts on'})`);
    assert.equal(session.notifications.get().length > 0, disabledFeatures.length === 0, 'the log follows the notification features');
    session.destroy();
  }
});

test('U08: a missing or refusing Web Audio leaves executions silent', async () => {
  const { createDefaultExecutionSound } = await loadModule('src/core/execution-sound.ts');
  assert.doesNotThrow(() => createDefaultExecutionSound(undefined).playExecution());
  const refusing = createDefaultExecutionSound(class { constructor() { throw new Error('autoplay'); } });
  assert.doesNotThrow(() => refusing.playExecution());
  refusing.close();
});

test('U08: an unchanged page layout keeps its identity so open settings rows are not rebuilt', async () => {
  const { session } = await simulatedSession({ flags: { supportMultipleExitLevels: false } });
  const first = settings.tradingSettingsSnapshot(session);
  session.updateDisplaySettings({ showReverse: false });
  const second = settings.tradingSettingsSnapshot(session);
  assert.equal(second.sections, first.sections);
  assert.equal(second.values.showReverse, false);
  session.destroy();
});

test('U08: the Buy/sell row is listed only when the buy_sell_buttons feature can show buttons', async () => {
  const { session } = await simulatedSession({ options: { disabledFeatures: ['buy_sell_buttons'] } });
  const snapshot = settings.tradingSettingsSnapshot(session);
  assert.equal(fieldIds(snapshot).includes('buySellButtons'), false);
  assert.throws(() => settings.applyTradingSettings(session, { buySellButtons: false }), { code: 'invalid-input' });
  session.destroy();
});
