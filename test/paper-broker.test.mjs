import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';

const paper = await loadModule('src/paper/index.ts');
const { OrderStatus, OrderType, ParentType, Side } = await loadModule('src/contracts/broker.ts');
const { createPaperBroker, executableQuote, netFill, onTick, shouldFill, validQuantity, intervalFinanceSchedule, PaperRejection } = paper;
const { userMessage } = await loadModule('src/core/errors.ts');

/** A host market with one gold symbol in EUR, its quotes and demand, recorded for assertions. */
function market() {
  const quotes = new Map(), listeners = new Set(), demands = new Map();
  const gold = { symbol: 'XAU/EUR', description: 'Gold', type: 'commodity', currency: 'EUR', tick: 0.1, quantityStep: 0.5, defaultQuantity: 1 };
  return {
    quotes,
    listeners,
    demands,
    port: {
      instrument: symbol => (symbol === 'DEMO:XAU' ? { tradable: true, instrument: gold } : { tradable: false, reason: `${symbol} is not on paper.` }),
      quote: symbol => quotes.get(symbol),
      onQuote(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      demand(symbol) {
        demands.set(symbol, (demands.get(symbol) ?? 0) + 1);
        return () => demands.set(symbol, demands.get(symbol) - 1);
      },
    },
    quote(bid, ask, symbol = 'DEMO:XAU') {
      quotes.set(symbol, { bid, ask, executableAt: Date.now() });
      for (const listener of listeners) listener(symbol);
    },
  };
}

function host() {
  const orders = [], positions = [], equity = [], statuses = [];
  return {
    orders,
    positions,
    equity,
    statuses,
    host: {
      orderUpdate: order => orders.push(order),
      positionUpdate: position => positions.push(structuredClone(position)),
      executionUpdate() {},
      plUpdate() {},
      equityUpdate: value => equity.push(value),
      connectionStatusUpdate: status => statuses.push(status),
      pipValueUpdate() {},
      defaultContextMenuActions: async () => [],
      factory: { createWatchedValue: value => ({ value: () => value, setValue() {} }) },
    },
  };
}

/** Runs account updates only when the test flushes them, so coalescing is observable. */
function manualSchedule() {
  const schedule = { requests: 0, flush: () => {} };
  return {
    schedule,
    factory: flush => {
      schedule.flush = flush;
      return { request: () => void schedule.requests++, cancel() {}, dispose() {} };
    },
  };
}

test('paper rules: fresh executable side, crossings, net fills, quantity and tick checks', () => {
  const quote = { bid: 99, ask: 101, executableAt: 100 };
  assert.equal(executableQuote(quote, Side.Buy, 100), 101);
  assert.equal(executableQuote(quote, Side.Sell, 100), 99);
  assert.throws(() => executableQuote(quote, Side.Buy, 16_000), /fresh bid and ask/);
  assert.equal(executableQuote(quote, Side.Buy, 16_000, 20_000), 101, 'the quote age limit is configurable');
  assert.throws(() => executableQuote({ ...quote, executableAt: undefined }, Side.Buy, 100));
  assert.equal(shouldFill(OrderType.Limit, Side.Buy, 101, 100), false);
  assert.equal(shouldFill(OrderType.Limit, Side.Buy, 99, 100), true);
  assert.equal(shouldFill(OrderType.Stop, Side.Sell, 99, undefined, 100), true);
  assert.equal(shouldFill(OrderType.StopLimit, Side.Buy, 99, 100, 98), false);
  assert.deepEqual(netFill({ side: Side.Buy, qty: 4, avgPrice: 100 }, Side.Sell, 2, 110), { side: Side.Buy, qty: 2, avgPrice: 100, realized: 20 });
  assert.deepEqual(netFill({ side: Side.Buy, qty: 4, avgPrice: 100 }, Side.Sell, 6, 90), { side: Side.Sell, qty: 2, avgPrice: 90, realized: -40 });
  assert.equal(validQuantity({ quantityStep: 0.5 }, 1.5), true);
  assert.equal(validQuantity({ quantityStep: 0.5 }, 1.2), false);
  assert.equal(onTick(2000.3, 0.1), true);
  assert.equal(onTick(2000.35, 0.1), false);
  assert.equal(onTick(-1, 0.1), false);
});

test('the paper broker trades any host symbol in the account currency and refuses others with the host reason', async () => {
  const prices = market(), recorded = host();
  const paperBroker = createPaperBroker(prices.port, { currency: 'EUR', balance: 5_000 });
  const broker = paperBroker.brokerFactory(recorded.host);
  try {
    assert.deepEqual(await broker.accountsMetainfo(), [{ id: 'paper-eur', name: 'Paper account · EUR', type: 'demo', currency: 'EUR' }]);
    assert.equal(await broker.isTradable('DEMO:XAU'), true);
    assert.equal(await broker.isTradable('DEMO:OIL'), false);
    const info = await broker.symbolInfo('DEMO:XAU');
    assert.equal(info.type, 'commodity');
    assert.equal(info.minTick, 0.1);
    assert.deepEqual(info.qty, { min: 0.5, max: 1_000_000, step: 0.5, default: 1 });
    assert.equal('baseCurrency' in info, false, 'an instrument without a base currency reports none');
    await assert.rejects(broker.symbolInfo('DEMO:OIL'), /DEMO:OIL is not on paper\./);

    prices.quote(1999.9, 2000);
    await assert.rejects(broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1.2 }), /valid quantity/);
    await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1, takeProfit: 2010, stopLoss: 1990 });
    const [position] = paperBroker.snapshot().positions;
    assert.equal(position.avgPrice, 2000, 'a market buy fills at the ask');
    assert.equal(prices.demands.get('DEMO:XAU'), 1, 'the broker asks the host to keep quotes flowing');
    const exits = recorded.orders.filter(order => order.parentType === ParentType.Position && order.status === OrderStatus.Working);
    assert.deepEqual(exits.map(order => [order.type, order.limitPrice ?? order.stopPrice]).sort(), [[OrderType.Limit, 2010], [OrderType.Stop, 1990]]);

    prices.quote(2010, 2010.1);
    assert.equal(paperBroker.snapshot().positions.length, 0, 'the take profit fills from the bid and closes the position');
    assert.equal(paperBroker.snapshot().balance, 5_010);
    assert.equal(recorded.orders.at(-1).status, OrderStatus.Canceled, 'the stop loss is cancelled with it');
    assert.equal(prices.demands.get('DEMO:XAU'), 0, 'demand is released once nothing is open');
  } finally {
    paperBroker.dispose();
  }
  assert.equal(prices.listeners.size, 0, 'dispose stops listening to quotes');
});

test('limit orders wait for the quote to cross; account updates go through the injected schedule', async () => {
  const prices = market(), recorded = host(), { schedule, factory } = manualSchedule();
  const paperBroker = createPaperBroker(prices.port, { financeSchedule: factory });
  const broker = paperBroker.brokerFactory(recorded.host);
  try {
    prices.quote(2000, 2000.1);
    const { orderId } = await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Limit, qty: 1, limitPrice: 1995 });
    assert.equal(paperBroker.snapshot().positions.length, 0);
    assert.equal(recorded.orders.find(order => order.id === orderId).status, OrderStatus.Working);
    prices.quote(1994.9, 1995);
    assert.equal(paperBroker.snapshot().positions[0].avgPrice, 1995);
    const before = schedule.requests;
    prices.quote(1996, 1996.1);
    prices.quote(1997, 1997.1);
    assert.equal(schedule.requests, before + 2, 'each quote asks for an account update');
    recorded.equity.length = 0;
    schedule.flush();
    assert.equal(recorded.equity.length, 1, 'one flush publishes one equity update');
    assert.equal(recorded.equity[0], 100_000 + 2);
  } finally {
    paperBroker.dispose();
  }
});

test('manual fills, rejections and disconnects never invent fills', async () => {
  const prices = market(), recorded = host();
  const paperBroker = createPaperBroker(prices.port, { automaticFills: false });
  const broker = paperBroker.brokerFactory(recorded.host);
  try {
    prices.quote(2000, 2000.1);
    await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1 });
    assert.equal(paperBroker.snapshot().positions.length, 0, 'manual mode waits for fillNext');
    paperBroker.fillNext(0.5);
    assert.equal(paperBroker.snapshot().positions[0].qty, 0.5);
    paperBroker.setFailure('reject');
    await assert.rejects(broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1 }), /rejected/);
    paperBroker.setConnected(false);
    await assert.rejects(broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1 }), /disconnected/);
    assert.equal(recorded.statuses.length, 1);
  } finally {
    paperBroker.dispose();
  }
});

test('paper rejections carry a code, so the chart shows their message instead of generic wording', async () => {
  const prices = market(), recorded = host();
  const paperBroker = createPaperBroker(prices.port);
  const broker = paperBroker.brokerFactory(recorded.host);
  try {
    prices.quote(2000, 2000.1);
    const failure = await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Market, qty: 1.2 }).catch(error => error);
    assert.ok(failure instanceof PaperRejection);
    assert.equal(failure.code, 'invalid');
    assert.equal(userMessage(failure, 'generic'), 'Enter a valid quantity.');
    const refused = await broker.symbolInfo('DEMO:OIL').catch(error => error);
    assert.equal(refused.code, 'unsupported');
    assert.equal(userMessage(new Error('raw provider text'), 'generic'), 'generic', 'a plain Error keeps the generic wording');
  } finally {
    paperBroker.dispose();
  }
});

test('only the price an order type uses is checked; a draft\'s leftover price from another type is ignored', async () => {
  const prices = market(), recorded = host();
  const paperBroker = createPaperBroker(prices.port);
  const broker = paperBroker.brokerFactory(recorded.host);
  try {
    prices.quote(2000, 2000.1);
    // Off-tick (tick 0.1) leftover stop price on a limit order, and a leftover limit below the stop's stop loss.
    const limit = await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Limit, qty: 1, limitPrice: 1995, stopPrice: 2000.05 });
    assert.equal(recorded.orders.find(order => order.id === limit.orderId).status, OrderStatus.Working);
    const stop = await broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Stop, qty: 1, stopPrice: 2010, limitPrice: 1990, stopLoss: 2000 });
    assert.equal(recorded.orders.find(order => order.id === stop.orderId).status, OrderStatus.Working, 'the stop loss is checked against the stop price');
    await assert.rejects(broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Limit, qty: 1, limitPrice: 1995.05 }), /instrument tick/);
    await assert.rejects(broker.placeOrder({ symbol: 'DEMO:XAU', side: Side.Buy, type: OrderType.Stop, qty: 1, limitPrice: 1995 }), /order price is required/);
  } finally {
    paperBroker.dispose();
  }
});

test('the default schedule coalesces account updates on a timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flushes = 0;
  const schedule = intervalFinanceSchedule(() => flushes++, 100);
  schedule.request();
  schedule.request();
  t.mock.timers.tick(100);
  assert.equal(flushes, 1);
  schedule.request();
  schedule.cancel();
  t.mock.timers.tick(100);
  assert.equal(flushes, 1);
  schedule.dispose();
});
