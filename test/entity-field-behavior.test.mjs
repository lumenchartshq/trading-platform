import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, flush } from './manual-clock.mjs';
/*
 * Broker-pushed entity fields witnessed by what the platform does with them: session ingestion
 * (validated, cloned at ingress, keyed by identity), Account Manager rendering through the
 * standard formatters, profit/notional estimates, ticket instrument handling and quote delivery.
 */
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { createTableCsv } = await loadModule('src/ui/account-manager/table-export.ts');
const { needsPositionProfit } = await loadModule('src/ui/account-manager/position-reader.ts');
const { positionProfit, instrumentTickValue, orderNotional } = await loadModule('src/core/financial-rules.ts');
const { quantityModeAvailable } = await loadModule('src/core/quantity-input.ts');
const { legacyExitLevel } = await loadModule('src/core/exit-level-draft.ts');
const { createTicketController } = await loadModule('src/ui/order-ticket/controller.ts');
const { createDomController } = await loadModule('src/ui/dom/controller.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');

const formatters = stringFormatters;
const settingsStore = () => { const map = new Map(); return mapSettings(map); };
const instrument = { description: 'Example', qty: { min: 1, max: 100, step: 1, default: 2 }, pipValue: 1, pipSize: 0.01, minTick: 0.01, currency: 'USD' };
const baseOrder = { id: 'O', symbol: 'X', side: 1, type: 1, qty: 2, status: 6, limitPrice: 10 };
/** Hand-written broker: every entity reaches the session through the real host callbacks. */
async function handFixture(configure) {
  const clock = new ManualClock();
  let host, broker;
  const session = createTradingSession({
    clock, settingsKey: 'test', settings: settingsStore(), formatters,
    marketData: { acquireQuotes: () => () => {}, acquireDepth: () => () => {} },
    brokerFactory: h => {
      host = h;
      broker = { connectionStatus: () => 1, currentAccount: () => 'A', accountsMetainfo: async () => [{ id: 'A', name: 'Account A', currency: 'USD' }], accountManagerInfo: () => ({ accountTitle: 'Test', summary: [], orderColumns: [], positionColumns: [] }), orders: async () => [baseOrder], positions: async () => [], individualPositions: async () => [], ordersHistory: async () => [], executions: async () => [], symbolInfo: async () => instrument, isTradable: async () => true, chartContextMenuActions: async () => [], placeOrder: async () => ({}), modifyOrder: async () => {}, cancelOrder: async () => {} };
      configure?.(broker, h);
      return broker;
    },
  });
  await session.ready;
  return { session, host, broker, clock };
}
async function simulated(profile = 'equity-net', configure, flags = {}) {
  const simulation = createDeterministicBroker({ profile });
  Object.assign(simulation.brokerConfig.configFlags, flags);
  const session = createTradingSession({
    ...simulation, settings: settingsStore(), formatters,
    brokerFactory: host => { const broker = simulation.brokerFactory(host); configure?.(broker, host); return broker; },
  });
  await session.ready;
  return { session, simulation, calls: method => simulation.controls.calls().filter(call => call.method === method) };
}
const plain = { format: String };
const tableFormats = { price: plain, quantity: plain, numeric: plain, integer: plain, variable: plain };
/** The Account Manager export path: broker-declared columns resolved and formatted per row. */
async function renderRows(reader, columns, accountCurrency) {
  const csv = await createTableCsv({ ids: reader.ids(), reader, columns, environment: { locale: 'en', timezone: 'UTC' }, accountCurrency, formatters: async () => tableFormats, clock: new ManualClock(), assertCurrent() {} });
  return csv.slice(1).trimEnd().split('\r\n').slice(1).map(line => line.slice(1, -1).split('","').map(cell => cell.replace(/^'/, '')));
}
const utcDate = value => new Intl.DateTimeFormat('en', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const positionColumns = [
  { id: 'id', label: 'ID', dataFields: ['id'] },
  { id: 'last', label: 'Last', dataFields: ['lastPrice'], formatter: 'formatPrice' },
  { id: 'bid', label: 'Bid', dataFields: ['bidPrice'], formatter: 'formatPrice' },
  { id: 'ask', label: 'Ask', dataFields: ['askPrice'], formatter: 'formatPrice' },
  { id: 'plPercent', label: 'P&L %', dataFields: ['unrealizedPlPercent'], formatter: 'profitInPercent' },
  { id: 'plQty', label: 'P&L per unit', dataFields: ['unrealizedPlQty', 'currency'], formatter: 'profitInInstrumentCurrency' },
  { id: 'value', label: 'Market value', dataFields: ['marketValue', 'currency'], formatter: 'fixedInCurrency' },
  { id: 'type', label: 'Type', dataFields: ['type', 'parentId', 'stopType'], formatter: 'type' },
  { id: 'updated', label: 'Updated', dataFields: ['updateTime'], formatter: 'date' },
];
const brokerFields = { lastPrice: 11, bidPrice: 10.9, askPrice: 11.1, unrealizedPlPercent: 5, unrealizedPlQty: 0.5, marketValue: 22, stopType: 1, currency: 'EUR', updateTime: 1700000000000 };
const renderedFields = ['11', '10.9', '11.1', '5%', '+0.5 EUR', '22 EUR', 'Trailing stop', utcDate(1700000000000)];

test('X08: PositionBase id keys the net position store; a repeat id replaces the row and a qty 0 push for that id removes it', async () => {
  const f = await handFixture();
  f.host.positionUpdate({ id: 'X', symbol: 'X', side: 1, qty: 2, avgPrice: 10 });
  f.host.positionUpdate({ id: 'Y', symbol: 'Y', side: -1, qty: 1, avgPrice: 5 });
  f.host.positionUpdate({ id: 'X', symbol: 'X', side: 1, qty: 3, avgPrice: 10.5 });
  assert.deepEqual([...f.session.state.positions.ids()].sort(), ['X', 'Y']);
  assert.equal(f.session.state.positions.get('X').qty, 3);
  f.host.positionUpdate({ id: 'X', symbol: 'X', side: 1, qty: 0, avgPrice: 10.5 });
  assert.deepEqual(f.session.state.positions.ids(), ['Y']);
  f.session.destroy();
});

test('X08: PositionBase lastPrice, bidPrice, askPrice, unrealizedPlPercent, unrealizedPlQty, marketValue, stopType, currency and updateTime are cloned at ingress and rendered by Account Manager formatters', async () => {
  const f = await handFixture();
  const pushed = { id: 'X', symbol: 'X', side: 1, qty: 2, avgPrice: 10, ...brokerFields };
  f.host.positionUpdate(pushed);
  pushed.lastPrice = 99; pushed.currency = 'JPY';
  const stored = f.session.state.positions.get('X');
  assert(Object.isFrozen(stored));
  assert.deepEqual({ ...stored }, { id: 'X', symbol: 'X', side: 1, qty: 2, avgPrice: 10, ...brokerFields }, 'later mutation of the pushed object is not observed');
  assert.deepEqual(await renderRows(f.session.state.positions, positionColumns), [['X', ...renderedFields]]);
  for (const field of ['unrealizedPlPercent', 'unrealizedPlQty']) assert.equal(needsPositionProfit([field], false), true, `${field} columns refresh with table P&L`);
  f.session.destroy();
});

test('X08/C01: IndividualPositionBase lastPrice, unrealizedPlPercent, unrealizedPlQty, stopType and currency are cloned at ingress and rendered by Account Manager formatters', async () => {
  const f = await handFixture();
  const pushed = { id: 'I', symbol: 'X', side: 1, qty: 2, price: 10, date: 1000, ...brokerFields };
  f.host.individualPositionUpdate(pushed);
  pushed.unrealizedPlQty = -7;
  const stored = f.session.state.individualPositions.get('I');
  assert(Object.isFrozen(stored));
  assert.equal(stored.unrealizedPlQty, 0.5);
  const [row] = await renderRows(f.session.state.individualPositions, positionColumns);
  assert.deepEqual(row, ['I', ...renderedFields]);
  f.session.destroy();
});

test('A01/O01: AccountMetainfo currency is exposed per account and labels account-currency profit and enables percent-of-equity sizing only when it matches the instrument currency', async () => {
  const f = await handFixture();
  const account = f.session.accounts.get().find(value => value.id === f.session.state.connection.get().accountId);
  assert.equal(account.currency, 'USD');
  f.host.positionUpdate({ id: 'X', symbol: 'X', side: 1, qty: 2, avgPrice: 10, unrealizedPl: 12 });
  const column = [{ id: 'pl', label: 'P&L', dataFields: ['unrealizedPl'], formatter: 'profit' }];
  assert.deepEqual(await renderRows(f.session.state.positions, column, account.currency), [['+12 USD']]);
  assert.deepEqual(await renderRows(f.session.state.positions, column, undefined), [['+12']]);
  const context = { instrument: { ...instrument, type: 'stock' }, price: 10, equity: 1000 };
  assert.equal(quantityModeAvailable('percentage', { ...context, accountCurrency: account.currency }), true);
  assert.equal(quantityModeAvailable('percentage', { ...context, accountCurrency: 'EUR' }), false);
  assert.equal(quantityModeAvailable('percentage', context), false);
  f.session.destroy();
});

test('C01/C03: IndividualPositionBase canBeClosed false rejects closing before any broker close call', async () => {
  const f = await simulated('fx-netting');
  const id = f.session.state.individualPositions.ids()[0];
  const current = f.session.state.individualPositions.get(id);
  f.session.host.individualPositionUpdate({ ...current, canBeClosed: false });
  await assert.rejects(f.session.commands.close({ id, individual: true, context: f.session.commands.context(id, 'individualPosition') }), error => error.code === 'unsupported');
  assert.equal(f.calls('closeIndividualPosition').length, 0);
  f.session.host.individualPositionUpdate({ ...current, canBeClosed: true });
  const result = await f.session.commands.close({ id, individual: true, context: f.session.commands.context(id, 'individualPosition') });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(f.calls('closeIndividualPosition').length, 1);
  f.session.destroy();
});

test('B01/B04: Brackets stopLoss and takeProfit reach editIndividualPositionBrackets and the confirmed IndividualPositionBase stopLoss and takeProfit seed the protection draft', async () => {
  const f = await simulated('fx-netting');
  const id = f.session.state.individualPositions.ids()[0];
  const result = await f.session.commands.editProtection({ id, individual: true, context: f.session.commands.context(id, 'individualPosition'), brackets: { takeProfit: 110, stopLoss: 90 } });
  assert.equal(result.outcome, 'confirmed');
  const [edit] = f.calls('editIndividualPositionBrackets');
  assert.equal(edit.args[0], id);
  assert.equal(edit.args[1].takeProfit, 110);
  assert.equal(edit.args[1].stopLoss, 90);
  const position = f.session.state.individualPositions.get(id);
  assert.equal(position.takeProfit, 110);
  assert.equal(position.stopLoss, 90);
  const draft = legacyExitLevel(position, position.qty, 'draft');
  assert.equal(draft.takeProfit, 110);
  assert.equal(draft.stopLoss, 90);
  f.session.destroy();
});

test('X08: Execution id keys executions; a repeated id updates one row and the copy is taken at ingress', async () => {
  const f = await handFixture();
  const execution = { id: 'E', symbol: 'X', side: 1, qty: 1, price: 10, time: 1000 };
  f.host.executionUpdate(execution);
  execution.price = 50;
  f.host.executionUpdate({ ...execution, id: 'E', price: 11 });
  f.host.executionUpdate({ ...execution, id: 'F', price: 12 });
  assert.deepEqual([...f.session.state.executions.ids()].sort(), ['E', 'F']);
  assert.equal(f.session.state.executions.get('E').price, 11);
  f.session.destroy();
});

test('X08: PlacedOrder id keys orders and cancel addresses it; PlacedOrder updateTime renders through the date formatter', async () => {
  const cancelled = [];
  const f = await handFixture(broker => { broker.cancelOrder = async id => { cancelled.push(id); f.host.orderUpdate({ ...baseOrder, id, status: 1 }); }; });
  f.host.orderUpdate({ ...baseOrder, id: 'O', updateTime: 1700000000000 });
  f.host.orderUpdate({ ...baseOrder, id: 'O2', limitPrice: 9 });
  assert.deepEqual([...f.session.state.orders.ids()].sort(), ['O', 'O2']);
  const rows = await renderRows(f.session.state.orders, [{ id: 'id', label: 'ID', dataFields: ['id'] }, { id: 'updated', label: 'Updated', dataFields: ['updateTime'], formatter: 'date' }]);
  assert.deepEqual(rows.find(row => row[0] === 'O'), ['O', utcDate(1700000000000)]);
  assert.deepEqual(rows.find(row => row[0] === 'O2'), ['O2', '']);
  await f.session.commands.cancel({ context: f.session.commands.context('O'), id: 'O' });
  assert.deepEqual(cancelled, ['O']);
  assert.equal(f.session.state.orders.get('O').status, 1);
  assert.equal(f.session.state.orders.get('O2').status, 6);
  f.session.destroy();
});

test('U02: OrderDuration type is the duration value; a PlacedOrder duration survives ticket modification while new orders get the broker default type', async () => {
  const f = await simulated();
  const ticket = createTicketController(f.session);
  await ticket.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, { type: 1, limitPrice: 100 });
  assert.deepEqual(ticket.state.get().order.duration, { type: 'GTC' }, 'default duration type is OrderDurationMetaInfo.value');
  const placed = { id: 'P1', symbol: 'SIM:X', side: 1, type: 1, qty: 2, status: 6, limitPrice: 99, duration: { type: 'GTD', datetime: 1900000000 } };
  f.session.host.orderUpdate(placed);
  await ticket.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, f.session.state.orders.get('P1'));
  assert.deepEqual(ticket.state.get().order.duration, { type: 'GTD', datetime: 1900000000 });
  ticket.destroy?.();
  f.session.destroy();
});

test('D03: PlacedOrder filledQty reduces the working quantity annotated on the depth ladder', async () => {
  const simulation = createDeterministicBroker();
  simulation.brokerConfig.configFlags.supportLevel2Data = true;
  const session = createTradingSession({ ...simulation, enabledFeatures: ['dom_widget'], settings: settingsStore(), formatters });
  await session.ready;
  const controller = createDomController(session, { binding: new ValueStore({ id: 'chart', generation: 1, symbol: 'SIM:X' }) });
  try {
    await controller.ready; await flush();
    const key = controller.ladder.viewport.get().find(value => controller.ladder.row(value).get().price === 99.95);
    const before = controller.ladder.row(key).get().buyQuantity;
    session.host.orderUpdate({ id: 'partial', symbol: 'SIM:X', side: 1, type: 1, qty: 5, filledQty: 2, limitPrice: 99.95, status: 6 });
    assert.equal(controller.ladder.row(key).get().buyQuantity - before, 3);
    session.host.orderUpdate({ id: 'partial', symbol: 'SIM:X', side: 1, type: 1, qty: 5, filledQty: 4, limitPrice: 99.95, status: 6 });
    assert.equal(controller.ladder.row(key).get().buyQuantity - before, 1);
  } finally { controller.destroy(); session.destroy(); }
});

test('P01/P02: InstrumentInfo pipSize converts price distance into money and tick value; lotSize is the notional contract multiplier', () => {
  const position = { side: 1, qty: 2, avgPrice: 1.1 };
  const quotes = { bid: 1.1010, ask: 1.1012 };
  const forex = { qty: { min: 1, max: 100, step: 1 }, minTick: 0.00001, pipSize: 0.0001, pipValue: 10, currency: 'USD' };
  const money = positionProfit({ position, instrument: forex, quotes, mode: 'money', supportPLUpdate: false, source: 'chart' });
  assert.equal(Number(money.toFixed(6)), 200, '10 pips * 2 units * 10 per pip');
  assert.equal(Number(positionProfit({ position, instrument: { ...forex, pipSize: 0.001 }, quotes, mode: 'money', supportPLUpdate: false, source: 'chart' }).toFixed(6)), 20);
  assert.equal(Number(instrumentTickValue(1, forex).toFixed(6)), 1, 'one 0.00001 tick is a tenth of a 0.0001 pip');
  const contract = { qty: { min: 1, max: 100, step: 1 }, minTick: 0.01, pipSize: 0.01, type: 'futures', currency: 'USD' };
  assert.equal(orderNotional(2, 50, contract), undefined, 'no unit multiplier means no notional');
  assert.equal(orderNotional(2, 50, { ...contract, lotSize: 100 }), 10000);
  assert.equal(orderNotional(2, 50, { ...contract, lotSize: 100, bigPointValue: 10 }), 1000, 'bigPointValue wins over lotSize');
});

test('X08: InstrumentInfo description reaches the order ticket state the ticket header shows', async () => {
  const f = await simulated();
  const ticket = createTicketController(f.session);
  await ticket.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, { type: 1, limitPrice: 100 });
  assert.equal(ticket.state.get().instrument.description, 'Simulated instrument');
  ticket.destroy?.();
  f.session.destroy();
});

test('P04: InstrumentInfo baseCurrency and quoteCurrency reach the crypto ticket instrument and key the matching broker balances', async () => {
  const f = await simulated('crypto');
  f.session.host.cryptoBalanceUpdate('SIM', { symbol: 'SIM', total: 5, available: 4 });
  f.session.host.cryptoBalanceUpdate('USD', { symbol: 'USD', total: 1000, available: 900 });
  const ticket = createTicketController(f.session);
  await ticket.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, { type: 1, limitPrice: 100 });
  const { baseCurrency, quoteCurrency } = ticket.state.get().instrument;
  assert.deepEqual([baseCurrency, quoteCurrency], ['SIM', 'USD']);
  assert.equal(f.session.state.balances.get(baseCurrency).available, 4);
  assert.equal(f.session.state.balances.get(quoteCurrency).available, 900);
  ticket.destroy?.();
  f.session.destroy();
});

test('X08: TradingQuotes size, bid_size, ask_size, lastSize, spread, isDelayed, isHalted, isHardToBorrow and isNotShortable are validated, merged and delivered unchanged to quote consumers', async () => {
  const f = await handFixture();
  const received = [];
  const release = f.session.acquireQuotes('X', 'fast', value => received.push(value));
  const extra = { size: 7, bid_size: 3, ask_size: 4, lastSize: 2, spread: 0.2, isDelayed: true, isHalted: false, isHardToBorrow: true, isNotShortable: false };
  f.host.realtimeUpdate('X', { trade: 10, bid: 9.9, ask: 10.1, ...extra });
  f.host.realtimeUpdate('X', { trade: 10.05 });
  const expected = { trade: 10.05, bid: 9.9, ask: 10.1, ...extra };
  assert.deepEqual({ ...received.at(-1).value }, expected, 'a partial push keeps earlier fields');
  const { id: _id, ...stored } = f.session.state.quotes.get('X');
  assert.deepEqual(stored, expected);
  for (const invalid of [{ isHalted: 'yes' }, { bid_size: Number.NaN }]) {
    try { f.host.realtimeUpdate('X', invalid); } catch { /* rejected at ingress */ }
    const { id: _ignored, ...after } = f.session.state.quotes.get('X');
    assert.deepEqual(after, expected, `${Object.keys(invalid)[0]} of the wrong type is rejected`);
  }
  release();
  f.session.destroy();
});

test('X08: OrderRule id and severity supplied in brokerConfig.orderRules are ignored safely; placement and capabilities match a config without them', async () => {
  const outcomes = [];
  for (const orderRules of [undefined, [{ id: 'max-size', severity: 'error' }, { id: 'late-session', severity: 'warning' }]]) {
    const simulation = createDeterministicBroker();
    const session = createTradingSession({ ...simulation, brokerConfig: { ...simulation.brokerConfig, orderRules }, settings: settingsStore(), formatters });
    await session.ready;
    const result = await session.commands.place({ context: session.commands.context(), order: { symbol: 'SIM:X', side: 1, qty: 2, type: 1, limitPrice: 99 } });
    outcomes.push({ outcome: result.outcome, flags: session.policy.get().flags });
    session.destroy();
  }
  assert.equal(outcomes[1].outcome, 'confirmed');
  assert.deepEqual(outcomes[1], outcomes[0]);
});

const { formatStandard } = await loadModule('src/compat/formatters.ts');
const { symbolLabel } = await loadModule('src/core/features.ts');
test('U05/C01: PositionBase message and IndividualPositionBase message render OrderOrPositionMessage text, and OrderOrPositionMessage type sets the cell tone', () => {
  const context = { ...tableFormats, locale: 'en', timezone: 'UTC' };
  const cell = message => formatStandard('symbol', ['', 'SIM:X', message], context);
  assert.deepEqual(cell({ type: 'error', text: 'Margin call' }), { text: 'SIM:X', message: 'Margin call', tone: 'negative' });
  assert.deepEqual(cell({ type: 'warning', text: 'Close soon' }), { text: 'SIM:X', message: 'Close soon', tone: 'warning' });
  assert.deepEqual(cell({ type: 'information', text: 'Rolled over' }), { text: 'SIM:X', message: 'Rolled over' });
  assert.deepEqual(cell(undefined), { text: 'SIM:X' });
  assert.equal(cell({ type: 'error', text: '' }).message, undefined);
});
test('X08: InstrumentInfo brokerSymbol is the trading display name and falls back to the chart symbol', () => {
  assert.equal(symbolLabel('NYSE:ABC', { prefer_symbol_name_over_fullname: true }, 'ABC.N'), 'ABC.N');
  assert.equal(symbolLabel('NYSE:ABC', { prefer_symbol_name_over_fullname: false }, 'XNYS:ABC.N'), 'XNYS:ABC.N');
  assert.equal(symbolLabel('NYSE:ABC', { prefer_symbol_name_over_fullname: true }, 'XNYS:ABC.N'), 'ABC.N', 'the name preference also shortens brokerSymbol');
  assert.equal(symbolLabel('NYSE:ABC', { prefer_symbol_name_over_fullname: true }), 'ABC');
  assert.equal(symbolLabel('NYSE:ABC', { prefer_symbol_name_over_fullname: false }, ''), 'NYSE:ABC');
});
