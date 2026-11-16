import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { flush } from './manual-clock.mjs';
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { createHostDialogs } = await loadModule('src/compat/host-dialogs.ts');
const { DialogCoordinator } = await loadModule('src/core/dialog-coordinator.ts');
const { createTradingMarketData } = await loadModule('src/market-data/subscriptions.ts');
const { createDomController } = await loadModule('src/ui/dom/controller.ts');
const { formatDepthVolume } = await loadModule('src/ui/dom/ladder.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
const { BottomWidgetBarMode, NotificationType, OrderStatus, OrderType, Side } = await loadModule('src/contracts/broker.ts');

const instrument = { description: 'Example', qty: { min: 1, max: 100, step: 1, default: 2 }, pipValue: 1, pipSize: 0.01, minTick: 0.25 };
const baseOrder = { id: 'O', symbol: 'X', side: 1, type: 1, qty: 2, status: 6, limitPrice: 10 };
const basePosition = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 10 };
const baseIndividual = { id: 'I', symbol: 'X', side: 1, qty: 1, price: 10, date: 1700000000000 };
const formatters = stringFormatters;
const levels = rows => rows.map(({ price, volume }) => ({ price, volume }));
const settingsPort = (settings = new Map()) => (mapSettings(settings));

async function fixture(configure, overrides = {}) {
  let host, broker, factoryCalls = 0;
  const reads = { positions: 0, individualPositions: 0 };
  const session = createTradingSession({
    settingsKey: 'host-test', settings: settingsPort(), formatters,
    marketData: { acquireQuotes: () => () => {}, acquireDepth: () => () => {} },
    brokerConfig: { configFlags: { supportPositionNetting: true } },
    brokerFactory: h => {
      host = h; factoryCalls++;
      broker = {
        connectionStatus: () => 1, currentAccount: () => 'A', accountsMetainfo: async () => [{ id: 'A', name: 'Account A' }],
        accountManagerInfo: () => ({ accountTitle: 'Test', summary: [], orderColumns: [], positionColumns: [] }),
        orders: async () => [baseOrder], positions: async () => { reads.positions++; return [basePosition]; },
        individualPositions: async () => { reads.individualPositions++; return [baseIndividual]; },
        ordersHistory: async () => [], executions: async () => [], symbolInfo: async () => instrument, isTradable: async () => true,
        chartContextMenuActions: async () => [], placeOrder: async () => ({}), modifyOrder: async () => {}, cancelOrder: async () => {},
      };
      configure?.(broker, host); return broker;
    },
    ...overrides,
  });
  await session.ready;
  return { session, host, broker, reads, factoryCalls: () => factoryCalls };
}
function dialogFixture(custom, positions = { P: basePosition }) {
  const dialogs = new DialogCoordinator();
  const ui = createHostDialogs(dialogs, custom, () => baseOrder, id => positions[id]);
  const current = () => dialogs.current.get();
  const respond = value => dialogs.respond(current().id, value);
  return { dialogs, ui, current, respond };
}

// --- broker_factory / feature resolution -------------------------------------------------------------

test('X01: broker_factory is called once with the Trading Host and the returned broker serves the session', async () => {
  const f = await fixture();
  assert.equal(f.factoryCalls(), 1);
  assert.equal(f.host, f.session.host);
  assert.equal(typeof f.host.orderUpdate, 'function');
  assert.equal(f.session.state.orders.get('O').limitPrice, 10);
  f.session.destroy();
});

// --- position caches ---------------------------------------------------------------------------------

test('A01/O03: positionsFullUpdate clears the positions cache and re-requests positions from the broker', async () => {
  const f = await fixture();
  const before = f.reads.positions;
  f.broker.positions = async () => { f.reads.positions++; return [{ ...basePosition, id: 'P2', qty: 5 }]; };
  f.host.positionsFullUpdate(); await flush();
  assert.equal(f.reads.positions, before + 1);
  assert.deepEqual(f.session.state.positions.ids(), ['P2']);
  f.session.destroy();
  f.host.positionsFullUpdate(); await flush();
  assert.equal(f.reads.positions, before + 1, 'a closed session does not re-read');
});

test('A01: positionPartialUpdate merges custom Account Manager fields into an unchanged position', async () => {
  const f = await fixture();
  const patch = { custom: 'tagged' };
  f.host.positionPartialUpdate('P', patch); patch.custom = 'mutated';
  const position = f.session.state.positions.get('P');
  assert.equal(position.custom, 'tagged');
  assert.equal(position.qty, 2); assert.equal(position.avgPrice, 10);
  f.session.destroy();
});

test('C01/B01: individualPositionsFullUpdate clears the individual positions cache and re-requests them', async () => {
  const f = await fixture();
  assert.deepEqual(f.session.state.individualPositions.ids(), ['I']);
  const before = f.reads.individualPositions;
  f.broker.individualPositions = async () => { f.reads.individualPositions++; return [{ ...baseIndividual, id: 'I2' }]; };
  f.host.individualPositionsFullUpdate(); await flush();
  assert.equal(f.reads.individualPositions, before + 1);
  assert.deepEqual(f.session.state.individualPositions.ids(), ['I2']);
  f.session.destroy();
});

test('C03: individualPositionPartialUpdate merges custom fields into an unchanged individual position', async () => {
  const f = await fixture();
  f.host.individualPositionPartialUpdate('I', { note: 'hedge' });
  const individual = f.session.state.individualPositions.get('I');
  assert.equal(individual.note, 'hedge'); assert.equal(individual.qty, 1); assert.equal(individual.price, 10);
  f.session.destroy();
});

test('A01: getSymbolMinTick resolves the instrument minTick for the symbol', async () => {
  const f = await fixture();
  assert.equal(await f.host.getSymbolMinTick('X'), 0.25);
  f.session.destroy();
});

// --- notifications, dialogs and dropdown actions --------------------------------------------------

test('U09: showNotification appends to the notification log with Error as the default notificationType', async () => {
  const f = await fixture();
  const start = f.session.notifications.get().length;
  f.host.showNotification('Rejected', 'Margin too low');
  f.host.showNotification('Filled', 'Buy 2 X', NotificationType.Success);
  const added = f.session.notifications.get().slice(start);
  assert.deepEqual(added.map(({ title, text, type }) => ({ title, text, type })), [
    { title: 'Rejected', text: 'Margin too low', type: NotificationType.Error },
    { title: 'Filled', text: 'Buy 2 X', type: NotificationType.Success },
  ]);
  f.session.destroy();
});

test('U09: showMessageDialog opens a message dialog carrying title, text and textHasHTML', () => {
  const f = dialogFixture();
  f.ui.showMessageDialog('Notice', '<b>Closed</b>', true);
  assert.deepEqual(f.current().request, { kind: 'message', title: 'Notice', content: '<b>Closed</b>', html: true });
  f.respond(true);
  f.ui.showMessageDialog('Plain', 'Text');
  assert.equal(f.current().request.html, false);
  f.dialogs.destroy();
});

test('U09: showSimpleConfirmDialog resolves true for the main button and false for cancel with custom texts and checkbox', async () => {
  const f = dialogFixture();
  const approved = f.ui.showSimpleConfirmDialog('Confirm', ['Line 1', 'Line 2'], 'Go', 'Stop', true);
  assert.deepEqual(f.current().request, { kind: 'confirm', title: 'Confirm', content: ['Line 1', 'Line 2'], mainButtonText: 'Go', cancelButtonText: 'Stop', showDisableConfirmationsCheckbox: true });
  f.respond(true); assert.equal(await approved, true);
  const declined = f.ui.showSimpleConfirmDialog('Confirm', 'Single');
  f.respond(false); assert.equal(await declined, false);
  f.dialogs.destroy();
});

test('U09: showCancelMultipleOrdersDialog describes symbol, side and qty and calls the handler only after approval', async () => {
  const f = dialogFixture();
  let handled = 0;
  const declined = f.ui.showCancelMultipleOrdersDialog('X', Side.Sell, 7, async () => { handled++; });
  assert.deepEqual(f.current().request.content, ['X', 'Sell orders, 7 in total']);
  f.respond(false); await declined; assert.equal(handled, 0);
  const approved = f.ui.showCancelMultipleOrdersDialog('X', Side.Buy, 3, async () => { handled++; });
  f.respond(true); await approved; assert.equal(handled, 1);
  f.dialogs.destroy();
});

test('U09: host showReversePositionDialog confirms the position and runs the handler only when approved', async () => {
  const f = dialogFixture();
  let handled = 0;
  const declined = f.ui.showReversePositionDialog('P', async () => { handled++; return true; });
  assert.equal(f.current().request.title, 'Reverse position');
  assert.deepEqual(f.current().request.content, ['X', 'Long 2']);
  f.respond(false); assert.equal(await declined, false); assert.equal(handled, 0);
  const approved = f.ui.showReversePositionDialog('P', async () => { handled++; return true; });
  f.respond(true); assert.equal(await approved, true); assert.equal(handled, 1);
  await assert.rejects(f.ui.showReversePositionDialog('missing', async () => true), error => error.code === 'stale-context');
  f.dialogs.destroy();
});

test('U09: showTradingProperties opens the trading properties dialog', async () => {
  const f = await fixture();
  f.host.showTradingProperties();
  assert.equal(f.session.dialogs.current.get().request.kind, 'properties');
  f.session.destroy();
});

test('U05/X08: defaultDropdownMenuActions honours tradingProperties and restoreConfirmations and its actions open settings and restore confirmations', async () => {
  const f = await fixture();
  assert.deepEqual(f.host.defaultDropdownMenuActions().map(action => action.text), ['Trading settings', 'Restore confirmations']);
  assert.deepEqual(f.host.defaultDropdownMenuActions({ restoreConfirmations: false }).map(action => action.text), ['Trading settings']);
  assert.deepEqual(f.host.defaultDropdownMenuActions({ tradingProperties: false }).map(action => action.text), ['Restore confirmations']);
  const silent = f.host.silentOrdersPlacement();
  silent.setValue(true); assert.equal(silent.value(), true);
  const [settings, restore] = f.host.defaultDropdownMenuActions();
  restore.action(); assert.equal(silent.value(), false);
  settings.action(); assert.equal(f.session.dialogs.current.get().request.kind, 'properties');
  f.session.destroy();
});

// --- Account Manager visibility, suggested qty -------------------------------------------------------

test('U05/U06: getAccountManagerVisibilityMode reflects setAccountManagerVisibilityMode and activateBottomWidget restores Normal', async () => {
  const f = await fixture();
  const mode = f.host.getAccountManagerVisibilityMode(), seen = [];
  assert.equal(mode.value(), BottomWidgetBarMode.Normal);
  mode.subscribe(value => seen.push(value));
  f.host.setAccountManagerVisibilityMode(BottomWidgetBarMode.Minimized);
  assert.equal(f.host.getAccountManagerVisibilityMode().value(), BottomWidgetBarMode.Minimized);
  f.host.setAccountManagerVisibilityMode(BottomWidgetBarMode.Maximized);
  await f.host.activateBottomWidget();
  assert.equal(mode.value(), BottomWidgetBarMode.Normal);
  assert.deepEqual(seen, [BottomWidgetBarMode.Minimized, BottomWidgetBarMode.Maximized, BottomWidgetBarMode.Normal]);
  f.session.destroy();
});

test('U09: subscribeSuggestedQtyChange notifies per symbol on setQty and unsubscribeSuggestedQtyChange stops delivery', async () => {
  const f = await fixture();
  const x = [], y = [];
  const listenX = qty => x.push(qty), listenY = qty => y.push(qty);
  f.host.subscribeSuggestedQtyChange('X', listenX);
  f.host.subscribeSuggestedQtyChange('Y', listenY);
  f.host.setQty('X', 5); f.host.setQty('X', 5); f.host.setQty('Y', 9);
  assert.deepEqual(x, [5]); assert.deepEqual(y, [9]);
  f.host.unsubscribeSuggestedQtyChange('X', listenX);
  f.host.setQty('X', 6);
  assert.deepEqual(x, [5]); assert.equal(await f.host.getQty('X'), 6);
  f.session.destroy();
});

// --- BrokerCustomUI ---------------------------------------------------------------------------------

test('U05: BrokerCustomUI showPositionDialog replaces the built-in protection dialog and receives cloned position, brackets and focus', async () => {
  const received = [];
  const f = dialogFixture({ showPositionDialog: async (position, brackets, focus) => { received.push({ position, brackets, focus }); position.qty = 99; return true; } });
  const brackets = { takeProfit: 12, stopLoss: 8 };
  assert.equal(await f.ui.showPositionBracketsDialog(basePosition, brackets, 1), true);
  assert.equal(f.current(), undefined, 'no built-in dialog is opened');
  assert.deepEqual(received, [{ position: { ...basePosition, qty: 99 }, brackets, focus: 1 }]);
  assert.notEqual(received[0].brackets, brackets); assert.equal(basePosition.qty, 2);
  f.dialogs.destroy();
});

test('U05: BrokerCustomUI showReversePositionDialog decides reversal; false skips the handler and true runs it once', async () => {
  const answers = [false, true], received = [];
  const f = dialogFixture({ showReversePositionDialog: async position => { received.push(position); return answers.shift(); } });
  let handled = 0;
  assert.equal(await f.ui.showReversePositionDialog('P', async () => { handled++; return true; }), false);
  assert.equal(handled, 0);
  assert.equal(await f.ui.showReversePositionDialog('P', async () => { handled++; return true; }), true);
  assert.equal(handled, 1); assert.equal(f.current(), undefined);
  assert.deepEqual(received[0], basePosition); assert.notEqual(received[0], basePosition);
  f.dialogs.destroy();
});

test('U05/U07: BrokerCustomUI showClosePositionDialog owns close confirmation; declining sends no closePosition', async () => {
  const simulation = createDeterministicBroker({ profile: 'custom-ui' });
  Object.assign(simulation.brokerConfig.configFlags, { supportPreviewClosePosition: true });
  const session = createTradingSession({ ...simulation, settings: settingsPort(), formatters });
  await session.ready;
  const id = session.state.positions.ids()[0];
  const closing = session.requestClose({ id, context: session.commands.context(id, 'position') });
  await flush();
  const entry = session.dialogs.current.get();
  assert.equal(entry.request.title, 'Custom close'); assert.equal(entry.request.content, id);
  session.dialogs.respond(entry.id, false);
  assert.equal(await closing, undefined);
  const calls = simulation.controls.calls().map(call => call.method);
  assert.equal(calls.filter(method => method === 'closePosition').length, 0);
  assert.equal(calls.filter(method => method === 'previewClosePosition').length, 0);
  session.destroy();
});

// --- Depth of Market and quotes ---------------------------------------------------------------------

test('D01: domUpdate delivers Depth of Market data for the symbol to depth consumers', async () => {
  const f = await fixture();
  const received = [];
  const release = f.session.acquireDepth('X', data => received.push(data));
  await flush();
  f.host.domUpdate('X', { snapshot: true, bids: [{ price: 9.75, volume: 4 }], asks: [{ price: 10.25, volume: 6 }] });
  f.host.domUpdate('Y', { snapshot: true, bids: [{ price: 1, volume: 1 }], asks: [] });
  assert.equal(received.length, 1);
  assert.deepEqual(levels(received[0].bids), [{ price: 9.75, volume: 4 }]);
  assert.deepEqual(levels(received[0].asks), [{ price: 10.25, volume: 6 }]);
  release(); f.session.destroy();
});

test('D01/D04: subscribeDepth returns the id that unsubscribeDepth receives, and getQuotes answers the initial quote request', async () => {
  const depth = [], released = [], quoteRequests = [];
  const provider = {
    getQuotes: (symbols, onData, onError) => quoteRequests.push({ symbols, onData, onError }),
    subscribeQuotes() {}, unsubscribeQuotes() {},
    subscribeDepth: (symbol, callback) => { depth.push({ symbol, callback }); return `uid-${depth.length}`; },
    unsubscribeDepth: guid => released.push(guid),
  };
  const port = createTradingMarketData(provider, () => 0.01);
  const books = [];
  const releaseDepth = port.acquireDepth('X', data => books.push(data));
  assert.deepEqual(depth.map(entry => entry.symbol), ['X']);
  depth[0].callback({ snapshot: true, bids: [{ price: 9.99, volume: 3 }], asks: [] });
  assert.deepEqual(levels(books.at(-1).bids), [{ price: 9.99, volume: 3 }]);
  releaseDepth();
  assert.deepEqual(released, ['uid-1']);
  const quotes = [];
  const releaseQuotes = port.acquireQuotes('X', 'fast', value => quotes.push(value)); await flush();
  assert.deepEqual(quoteRequests[0].symbols, ['X']);
  quoteRequests[0].onData([{ n: 'X', s: 'ok', v: { lp: 10, bid: 9.9, ask: 10.1 } }]);
  assert.equal(quotes.at(-1).status, 'ready'); assert.equal(quotes.at(-1).value.trade, 10);
  releaseQuotes();
  const failing = port.acquireQuotes('Z', 'fast', value => quotes.push(value)); await flush();
  quoteRequests[1].onError('down');
  assert.equal(quotes.at(-1).status, 'error');
  failing(); port.destroy();
});

// --- Trading featuresets ----------------------------------------------------------------------------

test('U09: show_trading_notifications_history keeps the notification log recording when trading_notifications is disabled', async () => {
  const transition = async features => {
    const f = await fixture(undefined, features);
    const start = f.session.notifications.get().length;
    f.host.orderUpdate({ ...baseOrder, status: OrderStatus.Filled });
    const added = f.session.notifications.get().slice(start).map(entry => entry.title);
    f.session.destroy();
    return added;
  };
  assert.deepEqual(await transition({ disabledFeatures: ['trading_notifications'] }), ['Limit order executed']);
  assert.deepEqual(await transition({ disabledFeatures: ['trading_notifications', 'show_trading_notifications_history'] }), []);
  const f = await fixture();
  assert.equal(f.session.features.show_trading_notifications_history, true);
  f.session.destroy();
});

test('X01: order_panel defaults to true and disabled_features order_panel turns it off for the session', async () => {
  const on = await fixture(), off = await fixture(undefined, { disabledFeatures: ['order_panel'] });
  assert.equal(on.session.features.order_panel, true);
  assert.equal(off.session.features.order_panel, false);
  on.session.destroy(); off.session.destroy();
});

test('D02: dom_raw_volume_values feature switches DOM volumes from compact K/M suffixes to full values', async () => {
  const raw = await fixture(undefined, { enabledFeatures: ['dom_raw_volume_values'] }), compact = await fixture();
  assert.equal(formatDepthVolume(1234567, raw.session.features.dom_raw_volume_values), '1,234,567');
  assert.equal(formatDepthVolume(1234567, compact.session.features.dom_raw_volume_values), '1.234567M');
  raw.session.destroy(); compact.session.destroy();
});

test('D02: static_dom keeps the DOM ladder centred until explicit recenter while the default ladder follows price', async () => {
  const viewportAfterMove = async enabled => {
    const simulation = createDeterministicBroker();
    simulation.brokerConfig.configFlags.supportLevel2Data = true;
    const session = createTradingSession({ ...simulation, enabledFeatures: enabled, settings: settingsPort(), formatters });
    await session.ready;
    const controller = createDomController(session, { binding: new ValueStore({ id: 'chart', generation: 1, symbol: 'SIM:X' }) });
    await controller.ready; await flush();
    const before = controller.ladder.viewport.get();
    simulation.controls.quote('SIM:X', 150); await flush();
    const after = controller.ladder.viewport.get();
    const recentered = controller.ladder.recenter();
    const result = { moved: before !== after, recentered, centred: controller.ladder.viewport.get().includes(15000) };
    controller.destroy(); session.destroy();
    return result;
  };
  assert.deepEqual(await viewportAfterMove(['dom_widget', 'static_dom']), { moved: false, recentered: true, centred: true });
  const following = await viewportAfterMove(['dom_widget']);
  assert.equal(following.moved, true); assert.equal(following.centred, true);
});

test('B04: always_pass_called_order_to_modify sends the called bracket to modifyOrder instead of its parent', async () => {
  const sentId = async enabled => {
    const simulation = createDeterministicBroker();
    Object.assign(simulation.brokerConfig.configFlags, { supportModifyOrderPreview: false });
    const session = createTradingSession({ ...simulation, enabledFeatures: enabled ? ['always_pass_called_order_to_modify'] : [], settings: settingsPort(), formatters });
    await session.ready;
    const release = session.acquireQuotes('SIM:X', 'fast', () => {}); await flush();
    const placed = await session.commands.place({ context: session.commands.context(), order: { symbol: 'SIM:X', type: OrderType.Limit, side: Side.Buy, qty: 2, limitPrice: 100, takeProfit: 102, stopLoss: 99 } });
    const parent = placed.entityIds[0];
    const child = session.state.orders.ids().map(id => session.state.orders.get(id)).find(order => order.parentId === parent && order.type === OrderType.Limit);
    await session.commands.modify({ context: session.commands.context(child.id), order: { ...child, limitPrice: 103 } });
    const sent = simulation.controls.calls().filter(call => call.method === 'modifyOrder').at(-1).args[0];
    release(); session.destroy();
    return { sent: sent.id, child: child.id, parent };
  };
  const called = await sentId(true), parent = await sentId(false);
  assert.equal(called.sent, called.child);
  assert.equal(parent.sent, parent.parent);
});
