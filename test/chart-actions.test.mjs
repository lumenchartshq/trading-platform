import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { createChartActions } = await loadModule('src/ui/chart-actions.ts');
const { createTicketDock } = await loadModule('src/ui/ticket-dock.ts');
function fixture() {
  const binding = { id: 'C', generation: 1, symbol: 'X' }, calls = [];
  const order = { id: 'O', symbol: 'X', type: 1, side: 1, qty: 2, limitPrice: 100 };
  const position = { id: 'P', symbol: 'X', side: 1, qty: 2, takeProfit: 110 };
  let silent = false;
  let approved = true, outcome = 'confirmed';
  const context = (id, kind) => ({ accountId: 'A', generation: 2, revision: 8, id, kind });
  const session = {
    state: { connection: { get: () => ({ accountId: "A", generation: 2, phase: "ready" }) }, orders: { get: id => id === 'O' ? order : undefined }, positions: { get: id => id === 'P' ? position : undefined }, individualPositions: { get: id => id === 'P' ? position : undefined } },
    commands: {
      context,
      place: async request => { calls.push(["place", request]); return { outcome: "confirmed" }; },
      cancel: async request => { calls.push(['cancel', request]); },
      modify: async request => { calls.push(['modify', request]); },
      reverse: async request => { calls.push(['reverse', request]); return { outcome }; },
    },
    host: {
      silentOrdersPlacement: () => ({ value: () => silent }),
      getQty: async () => 7,
      showConfirmDialog: async () => approved,
      showCancelOrderDialog: async (_id, submit) => submit(),
      showReversePositionDialog: async (_id, submit) => submit(),
      showPositionBracketsDialog: async (...args) => calls.push(['protect', ...args]),
    },
    confirmationRequired: false,
    symbolInfo: async () => ({}),
    symbolPolicy: () => ({ flags: {}, orderTypes: [1, 2, 3], durations: [], symbol: {} }),
    requestClose: async request => { calls.push(['close', request]); return { outcome }; },
  };
  const collection = { charts: () => [{ binding: { get: () => binding } }] };
  const actions = createChartActions(session, collection, async (...args) => { calls.push(['open', ...args]); });
  return { actions, binding, calls, order, session, silent: value => { silent = value; }, approve: value => { approved = value; }, outcome: value => { outcome = value; } };
}

test('U04/O03: chart intents retain default order types, stop-price mapping and captured cancel context', async () => {
  const f = fixture();
  await f.actions.intent({ type: 'openTicket', binding: f.binding, side: -1 });
  await f.actions.intent({ type: 'openTicket', binding: f.binding, side: 1, price: 99 });
  await f.actions.intent({ type: 'openTicket', binding: f.binding, side: 1, price: 101, orderType: 3 });
  assert.deepEqual(f.calls.slice(0, 3).map(call => call[2]), [
    { side: -1, type: 2, limitPrice: undefined }, { side: 1, type: 1, limitPrice: 99 }, { side: 1, type: 3, stopPrice: 101 },
  ]);
  await f.actions.intent({ type: 'cancelOrder', binding: f.binding, entityId: 'O' });
  assert.equal(f.calls.at(-1)[0], 'cancel'); assert.equal(f.calls.at(-1)[1].context.accountId, 'A');
  assert.equal(f.actions.bindingFor('X'), f.binding);
  assert.deepEqual(f.actions.bindingFor('Y'), { id: 'unbound-ticket', generation: 0, symbol: 'Y' });
});

test('O03: overlay price commits retain the gesture revision and require confirmation', async () => {
  const f = fixture();
  const action = { binding: f.binding, entityId: 'O', kind: 'order', revision: 3, event: { type: 'dragCommit', gestureId: 'G', price: 99 } };
  f.approve(false); await f.actions.overlayAction(action); assert.deepEqual(f.calls, []);
  f.approve(true); await f.actions.overlayAction(action);
  assert.equal(f.calls[0][1].context.revision, 3);
  assert.equal(f.calls[0][1].order.limitPrice, 99);
  assert.equal(f.order.limitPrice, 100);
});

test('C01/B01: account position actions retain close outcome checks and individual protection ownership', async () => {
  const f = fixture();
  await f.actions.positionAction('P', true, 'close');
  assert.equal(f.calls[0][1].individual, true);
  assert.equal(f.calls[0][1].context.kind, 'individualPosition');
  f.outcome('unconfirmed');
  await assert.rejects(f.actions.positionAction('P', false, 'close'), error => error.code === 'broker-unavailable');
  await f.actions.positionAction('P', true, 'protect');
  assert.equal(f.calls.at(-1)[0], 'protect'); assert.equal(f.calls.at(-1)[2].takeProfit, 110);
});

test('U09: ticket dock reserves width for either ticket or position protection and releases it when closed', () => {
  let phase = 'closed', kind, width = 320;
  const sizes = [];
  const dock = createTicketDock({ dialogs: { current: { get: () => kind ? { request: { kind } } : undefined } } }, { state: { get: () => ({ phase }) } }, { setDockSize: (...args) => sizes.push(args) }, () => width);
  dock.syncTicketDock(); phase = 'ready'; dock.syncTicketDock();
  phase = 'closed'; kind = 'position'; width = 400; dock.syncTicketDock();
  kind = 'properties'; dock.syncTicketDock();
  assert.deepEqual(sizes, [['ticket', 0], ['ticket', 320], ['ticket', 400], ['ticket', 0]]);
});

test('OC01: price-order types mirror both sides above, below and exactly at the market', async () => {
  const { contextOrderType } = await loadModule('src/core/context-orders.ts');
  assert.deepEqual([99, 100, 101].map(price => contextOrderType(1, price, 100)), [1, 3, 3]);
  assert.deepEqual([99, 100, 101].map(price => contextOrderType(-1, price, 100)), [3, 3, 1]);
  assert.equal(contextOrderType(1, -5, -4), 1);
  assert.equal(contextOrderType(-1, -3, -4), 1);
});

test('OC02: explicit ticket opening never dispatches a placement or modification', async () => {
  const f = fixture();
  await f.actions.intent({ type: 'openTicket', binding: f.binding, side: -1, price: 101, orderType: 1 });
  assert.deepEqual(f.calls.map(call => call[0]), ['open']);
  assert.equal(f.calls[0][1], f.binding);
});


test('OC02: price-order placement uses broker quantity, captured price and one immediate dispatch', async () => {
  const f = fixture();
  f.silent(true);
  const action = { type: 'priceOrder', binding: f.binding, side: -1, price: 102, orderType: 1 };
  await Promise.all([f.actions.intent(action), f.actions.intent(action)]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'place');
  assert.deepEqual(f.calls[0][1].order, { symbol: 'X', side: -1, type: 1, qty: 7, limitPrice: 102 });
  f.session.confirmationRequired = true;
  await f.actions.intent(action);
  assert.equal(f.calls.at(-1)[0], 'open');
  f.session.confirmationRequired = false;
  await f.actions.intent({ ...action, binding: { ...f.binding, generation: 99 } });
  assert.equal(f.calls.length, 2);
});

test('OC07/OC08: immediate position protection uses the correct captured command and rejection never changes broker truth', async () => {
  const { simulatedSession } = await import('./support/session-fixture.mjs');
  const f = await simulatedSession();
  const { session, simulation } = f;
  const id = session.state.positions.ids()[0];
  const original = session.state.positions.get(id);
  const binding = { id: 'C', generation: 1, symbol: original.symbol };
  const collection = { charts: () => [{ binding: { get: () => binding } }] };
  const actions = createChartActions(session, collection, async () => assert.fail('immediate modification opened a ticket'));
  session.host.silentOrdersPlacement().setValue(true);
  const edit = session.chartEdits.begin(id, 'position', binding, { leg: 'takeProfit' });
  await actions.overlayAction({ binding, entityId: id, kind: 'position', revision: edit.context.revision, event: { type: 'dragCommit', gestureId: 'G', leg: 'takeProfit', price: 105 } });
  assert.equal(simulation.controls.calls().filter(call => call.method === 'editPositionBrackets').length, 1);
  assert.equal(session.state.positions.get(id).takeProfit, 105);
  const next = session.chartEdits.begin(id, 'position', binding, { leg: 'stopLoss' });
  simulation.controls.rejectNextOperation();
  await assert.rejects(actions.overlayAction({ binding, entityId: id, kind: 'position', revision: next.context.revision, event: { type: 'dragCommit', gestureId: 'G2', leg: 'stopLoss', price: 95 } }));
  assert.equal(session.state.positions.get(id).stopLoss, original.stopLoss);
  assert.equal(session.chartEdits.state.get(), undefined);
  session.destroy();
});

test('OC01: quarter-tick Plus labels retain the exact snapped price rather than rounding it to one decimal', async () => {
  const { simulatedSession } = await import('./support/session-fixture.mjs');
  const { createContextActions } = await loadModule('src/chart/context-actions.ts');
  const f = await simulatedSession();
  const release = f.session.acquireQuotes('SIM:X', 'fast', () => {});
  const instrument = { ...(await f.session.symbolInfo('SIM:X')), minTick: 0.25 };
  const actions = await createContextActions(f.session, () => instrument, error => { throw error; })({ id: 'C', generation: 1, symbol: 'SIM:X' }, 99.26, 'priceScale');
  assert.match(actions[0].text, /99\.25/); assert.equal(actions[0].intent.price, 99.25); assert.equal(actions[0].formattedPrice, '99.25');
  release(); f.session.destroy();
});
test('U09: ticket dock exposes ticket and position-pane openness through one rule', async () => {
  const { isPositionPaneEntry, ticketPhaseOpen } = await loadModule('src/ui/ticket-dock.ts');
  let phase = 'closed', kind;
  const dock = createTicketDock({ dialogs: { current: { get: () => kind ? { request: { kind } } : undefined } } }, { state: { get: () => ({ phase }) } }, { setDockSize() {} }, () => 300);
  assert.deepEqual([dock.isTicketOpen(), dock.isPositionPaneOpen(), dock.isOpen()], [false, false, false]);
  phase = 'review'; assert.deepEqual([dock.isTicketOpen(), dock.isOpen()], [true, true]);
  phase = 'closed'; kind = 'position'; assert.deepEqual([dock.isTicketOpen(), dock.isPositionPaneOpen(), dock.isOpen()], [false, true, true]);
  assert.equal(ticketPhaseOpen('closed'), false); assert.equal(isPositionPaneEntry({ request: { kind: 'order' } }), false);
});
test('OC01/X01: chart-price trade items share one wording', async () => {
  const { contextTradeLabel } = await loadModule('src/core/context-orders.ts');
  assert.equal(contextTradeLabel({ side: 1, type: 2 }), 'Buy');
  assert.equal(contextTradeLabel({ side: 1, formattedPrice: '99.40', type: 1 }), 'Buy @ 99.40 Limit');
  assert.equal(contextTradeLabel({ side: -1, qty: 2, symbol: 'X', formattedPrice: '101.20', type: 3 }), 'Sell 2 X @ 101.20 Stop');
});
test('OC01: Plus menu actions name a glyph for buy, sell, add order and the host trading settings', async () => {
  const { simulatedSession } = await import('./support/session-fixture.mjs');
  const { createContextActions, mapContextActions } = await loadModule('src/chart/context-actions.ts');
  const { markTradingSettingsAction } = await loadModule('src/core/context-orders.ts');
  const f = await simulatedSession();
  const release = f.session.acquireQuotes('SIM:X', 'fast', () => {});
  const instrument = await f.session.symbolInfo('SIM:X');
  const actions = await createContextActions(f.session, () => instrument, error => { throw error; })({ id: 'C', generation: 1, symbol: 'SIM:X' }, 99.26, 'priceScale');
  const icons = actions.filter(action => 'text' in action).map(action => [action.text.split(' ')[0], action.icon]);
  assert.deepEqual(icons.filter(([word]) => word === 'Buy' || word === 'Sell' || word === 'Add').map(([, icon]) => icon).sort(), ['add_order', 'buy', 'sell']);
  release(); f.session.destroy();

  const settings = { text: 'Trading settings', action() {} };
  markTradingSettingsAction(settings);
  const mapped = mapContextActions([settings, { text: 'Broker extra', action() {} }], () => ({ separator: true }));
  assert.deepEqual(mapped.map(item => item.icon), ['trading_settings', undefined], 'only the host settings item gets the settings glyph');
});
test('OC01: non-tradable symbols get no trade items in either chart menu; tradability is read once per account', async () => {
  const { simulatedSession } = await import('./support/session-fixture.mjs');
  const { createContextActions } = await loadModule('src/chart/context-actions.ts');
  let tradable = false, reads = 0;
  const f = await simulatedSession({
    configureBroker(broker) { broker.isTradable = async () => { reads++; return tradable; }; },
  });
  const release = f.session.acquireQuotes('SIM:X', 'fast', () => {});
  const instrument = await f.session.symbolInfo('SIM:X');
  const actionsFor = createContextActions(f.session, () => instrument, error => { throw error; });
  const binding = { id: 'C', generation: 1, symbol: 'SIM:X' };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  const pane = await actionsFor(binding, 99.26, 'pane');
  assert.equal(pane.some(action => 'intent' in action), false, 'right-click hides Buy/Sell for a non-tradable symbol');
  assert.ok(pane.some(action => 'text' in action && action.text === 'Trading settings'), 'broker actions stay');
  assert.deepEqual(await actionsFor(binding, 99.26, 'priceScale'), [], 'the Plus menu hides its trade items too');
  await f.session.tradability('SIM:X');
  assert.equal(reads, 1, 'both menus and the chart controls share one broker read');

  tradable = true;
  f.broker.connectionStatus = () => 3; f.host.connectionStatusUpdate(3); await flush();
  f.broker.connectionStatus = () => 1; f.host.connectionStatusUpdate(1); await flush();
  const again = await actionsFor(binding, 99.26, 'priceScale');
  assert.equal(reads, 2, 'a new account generation reads tradability again');
  assert.ok(again.some(action => 'intent' in action), 'trade items return once the broker allows trading');
  release(); f.session.destroy();
});

test('OC01: a failed tradability read hides trade items and is retried on the next menu', async () => {
  const { simulatedSession } = await import('./support/session-fixture.mjs');
  const { createContextActions } = await loadModule('src/chart/context-actions.ts');
  let fail = true, reads = 0;
  const f = await simulatedSession({
    configureBroker(broker) { broker.isTradable = async () => { reads++; if (fail) throw new Error('broker down'); return true; }; },
  });
  const release = f.session.acquireQuotes('SIM:X', 'fast', () => {});
  const instrument = await f.session.symbolInfo('SIM:X');
  const actionsFor = createContextActions(f.session, () => instrument, error => { throw error; });
  const binding = { id: 'C', generation: 1, symbol: 'SIM:X' };
  assert.deepEqual(await actionsFor(binding, 99.26, 'priceScale'), []);
  fail = false;
  assert.ok((await actionsFor(binding, 99.26, 'priceScale')).some(action => 'intent' in action));
  assert.equal(reads, 2, 'the failure was not cached');
  release(); f.session.destroy();
});
