import { ConnectionStatus, OrderStatus, OrderType, ParentType, Side, StandardFormatterName } from '../contracts/broker.js';
import type {
  AccountId,
  AccountManagerInfo,
  Brackets,
  Execution,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  InstrumentInfo,
  IWatchedValue,
  Order,
  Position,
  PreOrder,
  SingleBrokerMetaInfo,
} from '../contracts/broker.js';
import {
  intervalFinanceSchedule,
  type PaperFinanceSchedule,
  type PaperInstrument,
  type PaperMarket,
} from './market.js';
import { defaultQuoteMaxAgeMs, executableQuote, netFill, onTick, PaperRejection, shouldFill, validateProtection, validQuantity } from './rules.js';

/** What the paper broker supports: market, limit and stop orders with brackets, one net position per symbol. */
export const paperBrokerConfig: SingleBrokerMetaInfo = {
  configFlags: {
    supportOrdersHistory: true,
    supportPositions: true,
    supportExecutions: true,
    // The chart and position table can mark paper positions directly from quotes.
    supportPLUpdate: false,
    supportClosePosition: true,
    supportPartialClosePosition: true,
    supportReversePosition: false,
    supportOrderBrackets: true,
    supportPositionBrackets: true,
    supportStopLoss: true,
    supportStopOrders: true,
    supportStopLimitOrders: false,
    supportLevel2Data: false,
    supportMargin: false,
    supportModifyDuration: false,
    supportSymbolSearch: true,
  },
  tradedGroupConfig: { supportAdaptiveLayout: true },
  durations: [{ name: 'Good until cancelled', value: 'GTC', default: true }],
};

/** What the next broker action does, for rehearsing failures: proceed, reject, or wait twelve seconds first. */
export type PaperFailureAction = 'normal' | 'reject' | 'delay';

export interface PaperBrokerOptions {
  /** Fill orders as soon as the quote crosses their price. Off, orders wait for `fillNext`. Default true. */
  readonly automaticFills?: boolean;
  /** The account's starting balance. Default 100,000. */
  readonly balance?: number;
  /** The account currency, shown in the account manager. Default USD. */
  readonly currency?: string;
  /** How long a quote stays tradable. Default 15 seconds. */
  readonly quoteMaxAgeMs?: number;
  /** How P&L and equity updates are coalesced. Default: at most one every 250 ms. */
  readonly financeSchedule?: (flush: () => void) => PaperFinanceSchedule;
}

/**
 * A broker adapter that trades on paper in the browser: it fills market, limit
 * and stop orders against the host's quotes, keeps one net position per symbol
 * with take profit and stop loss, and reports through the chart's host updates.
 * Nothing is persisted or sent anywhere. Use it for demos, tests, or as a
 * starting point for a real adapter.
 */
export function createPaperBroker(market: PaperMarket, options: PaperBrokerOptions = {}) {
  let host: IBrokerConnectionAdapterHost | undefined,
    sequence = 0,
    balance = options.balance ?? 100000,
    disposed = false,
    connected = true,
    next: PaperFailureAction = 'normal';
  const automaticFills = options.automaticFills ?? true;
  const currency = options.currency ?? 'USD';
  const accountId = `paper-${currency.toLowerCase()}` as AccountId;
  const quoteMaxAgeMs = options.quoteMaxAgeMs ?? defaultQuoteMaxAgeMs;
  const orders = new Map<string, Order>(),
    positions = new Map<string, Position>(),
    executions: Execution[] = [],
    releases = new Map<string, () => void>();
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  const finance = (options.financeSchedule ?? intervalFinanceSchedule)(() => notifyFinance());
  const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let summary: AccountManagerInfo | undefined;
  let balanceValue: IWatchedValue<string> | undefined, equityValue: IWatchedValue<string> | undefined;
  const parentId = (order: Order) => ('parentId' in order ? order.parentId : undefined);
  const isOpenOrder = (order: Order) => order.status === OrderStatus.Working || order.status === OrderStatus.Inactive;
  const id = (kind: string) => `paper-${kind}-${++sequence}`;
  const priceFor = (symbol: string, side: Side) => executableQuote(market.quote(symbol), side, Date.now(), quoteMaxAgeMs);
  const publishOrder = (order: Order) => {
    orders.set(order.id, order);
    host?.orderUpdate(structuredClone(order));
  };
  const refreshDemand = () => {
    if (!market.demand) return;
    const symbols = new Set([...orders.values()].filter(order => order.status === OrderStatus.Working).map(order => order.symbol));
    for (const position of positions.values()) symbols.add(position.symbol);
    for (const [symbol, release] of releases)
      if (!symbols.has(symbol)) {
        release();
        releases.delete(symbol);
      }
    for (const symbol of symbols) if (!releases.has(symbol)) releases.set(symbol, market.demand(symbol));
  };
  const instrument = (symbol: string): PaperInstrument => {
    const lookup = market.instrument(symbol);
    if (!lookup.tradable) throw new PaperRejection('unsupported', lookup.reason);
    return lookup.instrument;
  };
  const guard = () => {
    if (disposed) throw new PaperRejection('unavailable', 'Paper session ended.');
    if (!connected) throw new PaperRejection('unavailable', 'Paper account is disconnected.');
  };
  const mutate = async (action: () => void) => {
    guard();
    const failure = next;
    next = 'normal';
    if (failure === 'reject') throw new PaperRejection('rejected', 'The QA broker rejected this action.');
    if (failure === 'delay')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(timer);
          resolve();
        }, 12000);
        pending.set(timer, () => reject(new PaperRejection('unavailable', 'Paper session ended.')));
      });
    guard();
    action();
    refreshDemand();
  };
  function notifyFinance() {
    finance.cancel();
    let unrealized = 0,
      complete = true;
    for (const position of positions.values()) {
      let pl: number | undefined;
      try {
        pl = (priceFor(position.symbol, position.side === Side.Buy ? Side.Sell : Side.Buy) - position.avgPrice) * position.qty * position.side;
      } catch {
        complete = false;
      }
      if (pl !== undefined) {
        unrealized += pl;
        position.extra = { pl };
        host?.plUpdate(position.id, pl);
      }
    }
    if (complete) host?.equityUpdate(balance + unrealized);
    balanceValue?.setValue(money.format(balance));
    if (complete) equityValue?.setValue(money.format(balance + unrealized));
  }
  function cancelProtection(parentKey: string) {
    for (const order of orders.values())
      if (parentId(order) === parentKey && isOpenOrder(order)) publishOrder({ ...order, status: OrderStatus.Canceled });
  }
  function cancelOrder(order: Order) {
    publishOrder({ ...order, status: OrderStatus.Canceled });
    if (!('parentId' in order)) {
      cancelProtection(order.id);
      return;
    }
    const field = order.type === OrderType.Limit ? 'takeProfit' : 'stopLoss';
    if (order.parentType === ParentType.Order) {
      const parent = orders.get(order.parentId);
      if (parent && isOpenOrder(parent)) publishOrder({ ...parent, [field]: undefined });
      return;
    }
    const position = positions.get(order.parentId);
    if (!position) return;
    position[field] = undefined;
    host?.positionUpdate(structuredClone(position));
  }
  /** Take profit and stop loss are child orders: inactive under a pending order, working under a position. */
  function syncProtectionOrders(
    parent: Order | Position,
    parentType: ParentType.Order | ParentType.Position,
    brackets: Brackets,
    qty: number,
    previousParentId = parent.id,
  ) {
    const children = [...orders.values()].filter(row => parentId(row) === previousParentId && isOpenOrder(row));
    const status = parentType === ParentType.Order ? OrderStatus.Inactive : OrderStatus.Working;
    for (const [kind, type, price] of [
      ['tp', OrderType.Limit, brackets.takeProfit],
      ['sl', OrderType.Stop, brackets.stopLoss],
    ] as const) {
      const child = children.find(row => row.type === type);
      if (price === undefined || qty <= 0) {
        if (child) publishOrder({ ...child, status: OrderStatus.Canceled });
        continue;
      }
      const priceField = type === OrderType.Limit ? 'limitPrice' : 'stopPrice';
      if (child && parentId(child) === parent.id && child.status === status && child.qty === qty && child[priceField] === price) continue;
      publishOrder({
        id: child?.id ?? id(kind),
        symbol: parent.symbol,
        side: parent.side === Side.Buy ? Side.Sell : Side.Buy,
        qty,
        type,
        status,
        parentId: parent.id,
        parentType,
        [priceField]: price,
      });
    }
  }
  function protection(position: Position, brackets: Brackets, activatingOrderId?: string) {
    cancelProtection(position.id);
    position.takeProfit = brackets.takeProfit;
    position.stopLoss = brackets.stopLoss;
    host?.positionUpdate(structuredClone(position));
    syncProtectionOrders(position, ParentType.Position, brackets, position.qty, activatingOrderId);
  }
  function fill(order: Order, price: number, amount = order.qty - (order.filledQty ?? 0)) {
    const filled = order.filledQty ?? 0;
    if (amount <= 0 || amount > order.qty - filled || !validQuantity(instrument(order.symbol), amount))
      throw new PaperRejection('invalid', 'Invalid fill quantity.');
    const positionId = `paper-position:${order.symbol}`,
      old = positions.get(positionId);
    if (parentId(order) && (!old || parentId(order) !== old.id)) return;
    const result = netFill(old, order.side, amount, price);
    balance += result.realized;
    const execution: Execution = { id: id('fill'), symbol: order.symbol, side: order.side, qty: amount, price, time: Date.now() / 1000 };
    executions.push(execution);
    if (executions.length > 1000) executions.shift();
    const filledQty = filled + amount;
    const remaining = order.qty - filledQty;
    publishOrder({
      ...order,
      status: remaining <= 0 ? OrderStatus.Filled : OrderStatus.Working,
      filledQty,
      avgPrice: ((order.avgPrice ?? 0) * filled + price * amount) / filledQty,
    });
    host?.executionUpdate(execution);
    if (old) cancelProtection(old.id);
    const position: Position = { id: positionId, symbol: order.symbol, side: result.side, qty: result.qty, avgPrice: result.avgPrice };
    if (result.qty > 0) {
      positions.set(positionId, position);
      host?.positionUpdate(position);
      if (!parentId(order)) {
        const opensOnOrderSide = position.side === order.side;
        const existing = old?.side === position.side ? old : undefined;
        const placed = opensOnOrderSide ? order : undefined;
        protection(
          position,
          { takeProfit: placed?.takeProfit ?? existing?.takeProfit, stopLoss: placed?.stopLoss ?? existing?.stopLoss },
          opensOnOrderSide && remaining <= 0 ? order.id : undefined,
        );
      }
    } else {
      positions.delete(positionId);
      host?.positionUpdate(position);
    }
    if (!parentId(order)) syncProtectionOrders(order, ParentType.Order, order, remaining);
    const settled = [...orders.values()].filter(row => !isOpenOrder(row));
    for (const row of settled.slice(0, -500)) orders.delete(row.id);
    notifyFinance();
    refreshDemand();
  }
  function evaluate(symbol: string) {
    if (disposed || !connected) return;
    if (!automaticFills) {
      if (positions.size) finance.request();
      return;
    }
    for (const order of [...orders.values()]) {
      if (order.symbol !== symbol || order.status !== OrderStatus.Working || orders.get(order.id)?.status !== OrderStatus.Working) continue;
      try {
        const price = priceFor(symbol, order.side);
        if (shouldFill(order.type, order.side, price, order.limitPrice, order.stopPrice)) fill(order, price);
      } catch {
        /* Wait for fresh executable quotes. */
      }
    }
    if (positions.size) finance.request();
  }
  function validate(order: PreOrder) {
    const item = instrument(order.symbol);
    if (!validQuantity(item, order.qty)) throw new PaperRejection('invalid', 'Enter a valid quantity.');
    if (![OrderType.Market, OrderType.Limit, OrderType.Stop].includes(order.type)) throw new PaperRejection('unsupported', 'This order type is unavailable.');
    if (order.side !== Side.Buy && order.side !== Side.Sell) throw new PaperRejection('invalid', 'Invalid order side.');
    for (const value of [order.limitPrice, order.stopPrice, order.takeProfit, order.stopLoss])
      if (value !== undefined && !onTick(value, item.tick)) throw new PaperRejection('invalid', 'Enter a price on the instrument tick.');
    if ((order.type === OrderType.Limit && order.limitPrice === undefined) || (order.type === OrderType.Stop && order.stopPrice === undefined))
      throw new PaperRejection('invalid', 'An order price is required.');
    const price = priceFor(order.symbol, order.side);
    validateProtection(order.side, order.limitPrice ?? order.stopPrice ?? price, order);
    const activeSymbols = new Set([...positions.values()].map(position => position.symbol));
    for (const row of orders.values()) if (row.status === OrderStatus.Working) activeSymbols.add(row.symbol);
    if (!activeSymbols.has(order.symbol) && activeSymbols.size >= 10) throw new PaperRejection('rejected', 'Paper trading supports up to ten active symbols.');
  }
  const off = market.onQuote(symbol => evaluate(symbol));
  const brokerFactory = (value: IBrokerConnectionAdapterHost): IBrokerTerminal => {
    host = value;
    const broker: IBrokerTerminal = {
      connectionStatus: () => (connected ? ConnectionStatus.Connected : ConnectionStatus.Disconnected),
      accountsMetainfo: async () => [{ id: accountId, name: `Paper account · ${currency}`, type: 'demo', currency }],
      currentAccount: () => accountId,
      chartContextMenuActions: (context, options) => value.defaultContextMenuActions(context, options),
      isTradable: async symbol => market.instrument(symbol).tradable,
      symbolInfo: async symbol => {
        const item = instrument(symbol);
        return {
          description: item.description,
          qty: { min: item.quantityStep, max: 1000000, step: item.quantityStep, default: item.defaultQuantity },
          pipSize: item.tick,
          pipValue: item.tick,
          minTick: item.tick,
          type: item.type,
          currency: item.currency,
          ...(item.baseCurrency === undefined ? {} : { baseCurrency: item.baseCurrency }),
          quoteCurrency: item.currency,
          brokerSymbol: item.symbol,
          allowedOrderTypes: [OrderType.Market, OrderType.Limit, OrderType.Stop],
        } satisfies InstrumentInfo;
      },
      accountManagerInfo: () =>
        (summary ??= {
          accountTitle: 'Paper trading',
          pages: [],
          summary: [
            { text: `Balance · ${currency}`, wValue: (balanceValue ??= value.factory.createWatchedValue(money.format(balance))) },
            { text: `Equity · ${currency}`, wValue: (equityValue ??= value.factory.createWatchedValue(money.format(balance))) },
          ],
          orderColumns: [
            { id: 'symbol', label: 'Symbol', dataFields: ['symbol'] },
            { id: 'qty', label: 'Quantity', dataFields: ['qty'], formatter: StandardFormatterName.FormatQuantity },
            { id: 'status', label: 'Status', dataFields: ['status'], formatter: StandardFormatterName.Status },
          ],
          positionColumns: [
            { id: 'symbol', label: 'Symbol', dataFields: ['symbol', 'symbol'], formatter: StandardFormatterName.Symbol },
            { id: 'side', label: 'Side', dataFields: ['side'], formatter: StandardFormatterName.Side },
            { id: 'qty', label: 'Qty', dataFields: ['qty'], formatter: StandardFormatterName.FormatQuantity },
            { id: 'avgPrice', label: 'Avg fill price', dataFields: ['avgPrice'], formatter: StandardFormatterName.FormatPrice },
            { id: 'profitLoss', label: `P&L · ${currency}`, dataFields: [['extra', 'pl']], formatter: StandardFormatterName.Profit },
            { id: 'takeProfit', label: 'Take profit', dataFields: ['takeProfit'], formatter: StandardFormatterName.FormatPrice },
            { id: 'stopLoss', label: 'Stop loss', dataFields: ['stopLoss'], formatter: StandardFormatterName.FormatPrice },
          ],
        }),
      orders: async () => structuredClone([...orders.values()].filter(isOpenOrder)),
      ordersHistory: async () => structuredClone([...orders.values()].filter(row => !isOpenOrder(row))),
      positions: async () => structuredClone([...positions.values()]),
      executions: async symbol => structuredClone(executions.filter(row => row.symbol === symbol)),
      placeOrder: async order => {
        let orderId = '';
        await mutate(() => {
          validate(order);
          if ([...orders.values()].filter(row => row.status === OrderStatus.Working).length >= 100) throw new PaperRejection('rejected', 'Paper order capacity reached.');
          orderId = id('order');
          const placed: Order = { ...order, id: orderId, status: OrderStatus.Working };
          publishOrder(placed);
          if (placed.type !== OrderType.Market || !automaticFills) syncProtectionOrders(placed, ParentType.Order, placed, placed.qty);
          evaluate(order.symbol);
        });
        return { orderId };
      },
      modifyOrder: async order =>
        mutate(() => {
          const old = orders.get(order.id);
          if (!old || old.status !== OrderStatus.Working) throw new PaperRejection('rejected', 'This order has changed.');
          if (old.symbol !== order.symbol || old.side !== order.side || parentId(old)) throw new PaperRejection('rejected', 'Edit protection from the position.');
          validate(order);
          if (order.qty <= (old.filledQty ?? 0)) throw new PaperRejection('invalid', 'Quantity must exceed the filled quantity.');
          const updated = { ...old, ...order, filledQty: old.filledQty, avgPrice: old.avgPrice };
          publishOrder(updated);
          if (updated.type !== OrderType.Market || !automaticFills)
            syncProtectionOrders(updated, ParentType.Order, updated, updated.qty - (updated.filledQty ?? 0));
          evaluate(order.symbol);
        }),
      cancelOrder: async orderId =>
        mutate(() => {
          const order = orders.get(orderId);
          if (!order || !isOpenOrder(order)) throw new PaperRejection('rejected', 'This order has changed.');
          cancelOrder(order);
        }),
      cancelOrders: async (symbol, side, ids) =>
        mutate(() => {
          for (const orderId of ids) {
            const order = orders.get(orderId);
            if (order?.symbol === symbol && (side === undefined || order.side === side) && isOpenOrder(order)) cancelOrder(order);
          }
        }),
      closePosition: async (positionId, amount) =>
        mutate(() => {
          const position = positions.get(positionId);
          if (!position) throw new PaperRejection('rejected', 'The position has closed.');
          const side = position.side === Side.Buy ? Side.Sell : Side.Buy,
            qty = amount ?? position.qty;
          if (!validQuantity(instrument(position.symbol), qty) || qty > position.qty) throw new PaperRejection('invalid', 'Enter a valid closing quantity.');
          fill({ id: id('close'), symbol: position.symbol, side, qty, type: OrderType.Market, status: OrderStatus.Working }, priceFor(position.symbol, side));
        }),
      editPositionBrackets: async (positionId, brackets) =>
        mutate(() => {
          const position = positions.get(positionId);
          if (!position) throw new PaperRejection('rejected', 'The position has closed.');
          const item = instrument(position.symbol);
          for (const price of [brackets.takeProfit, brackets.stopLoss])
            if (price !== undefined && !onTick(price, item.tick)) throw new PaperRejection('invalid', 'Invalid protection price.');
          const reference = priceFor(position.symbol, position.side === Side.Buy ? Side.Sell : Side.Buy);
          validateProtection(position.side, reference, brackets);
          protection(position, brackets);
        }),
      subscribePipValue(symbol) {
        const { tick } = instrument(symbol);
        host?.pipValueUpdate(symbol, { buyPipValue: tick, sellPipValue: tick });
      },
      unsubscribePipValue() {},
      subscribeEquity: () => notifyFinance(),
      unsubscribeEquity: () => {},
    };
    return broker;
  };
  return {
    brokerFactory,
    brokerConfig: paperBrokerConfig,
    /** Fills the newest waiting order whose price has been reached, fully or by `amount`. */
    fillNext(amount?: number) {
      guard();
      const order = [...orders.values()].reverse().find(row => row.status === OrderStatus.Working && !parentId(row));
      if (!order) throw new PaperRejection('rejected', 'There are no waiting orders.');
      const price = priceFor(order.symbol, order.side);
      if (!shouldFill(order.type, order.side, price, order.limitPrice, order.stopPrice)) throw new PaperRejection('rejected', 'The order price has not been reached.');
      fill(order, price, amount);
    },
    /** Makes the next broker action proceed, reject, or wait twelve seconds first. */
    setFailure(action: PaperFailureAction) {
      next = action;
    },
    setConnected(value: boolean) {
      connected = value;
      host?.connectionStatusUpdate(value ? ConnectionStatus.Connected : ConnectionStatus.Disconnected);
    },
    snapshot: () => ({ orders: [...orders.values()], positions: [...positions.values()], balance }),
    dispose() {
      disposed = true;
      finance.dispose();
      off();
      for (const [timer, reject] of pending) {
        clearTimeout(timer);
        reject();
      }
      pending.clear();
      for (const release of releases.values()) release();
      releases.clear();
    },
  };
}

export type PaperBroker = ReturnType<typeof createPaperBroker>;
