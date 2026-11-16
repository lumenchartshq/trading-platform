import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock } from './manual-clock.mjs';
const { createHostFactory } = await loadModule('src/compat/factory.ts');
const { DisposalScope } = await loadModule('src/core/disposal.ts');
const { createNumericFormatter, createPriceFormatter, createDefaultTradingFormatters } = await loadModule('src/compat/default-formatters.ts');
const { createTableCsv } = await loadModule('src/ui/account-manager/table-export.ts');
const { EntityStore } = await loadModule('src/core/entity-store.ts');

function brokerFactory() {
  const scope = new DisposalScope();
  const formatters = createDefaultTradingFormatters('en-US', async () => ({ resolved: false }));
  return { scope, factory: createHostFactory(formatters, scope) };
}

const services = {
  numeric: createNumericFormatter('en-US', 2),
  integer: createNumericFormatter('en-US', 0),
  variable: createNumericFormatter('en-US', 1, true),
  quantity: createNumericFormatter('en-US', 0),
  price: createPriceFormatter('en-US', 100, 1),
};

/** Runs rows through the account-table export pipeline (dataFields -> values -> formatter). */
async function exportCells(rows, columns, { custom, timezone = 'UTC' } = {}) {
  const reader = new EntityStore(() => {});
  reader.replace(rows);
  try {
    const csv = await createTableCsv({
      ids: reader.ids(), reader, columns, custom,
      environment: { locale: 'en-US', timezone },
      formatters: async () => services,
      clock: new ManualClock(),
      assertCurrent() {},
    });
    return csv.slice(1).trimEnd().split('\r\n').slice(1)
      .map(line => line.slice(1, -1).split('","'));
  } finally { reader.destroy(); }
}

test('U08/U06: IBoxedValue setValue stores the value that IBoxedValueReadOnly value returns on a broker watched value', () => {
  const { scope, factory } = brokerFactory();
  const watched = factory.createWatchedValue(1);
  assert.equal(watched.value(), 1);
  watched.setValue(5);
  assert.equal(watched.value(), 5);
  scope.destroy();
});

test('U08/U06: IObservable subscribe evokes on change and IObservable unsubscribe stops only that callback', () => {
  const { scope, factory } = brokerFactory();
  const watched = factory.createWatchedValue('a'), first = [], second = [];
  const one = value => first.push(value), two = value => second.push(value);
  watched.subscribe(one); watched.subscribe(two);
  watched.setValue('b');
  watched.unsubscribe(one);
  watched.setValue('c');
  assert.deepEqual(first, ['b']);
  assert.deepEqual(second, ['b', 'c']);
  scope.destroy();
});

test('U08/U06: IWatchedValue setValue skips unchanged values unless forceUpdate; IWatchedValue subscribe honours callWithLast; IWatchedValue unsubscribe(null) clears all', () => {
  const { scope, factory } = brokerFactory();
  const watched = factory.createWatchedValue(3), events = [];
  watched.subscribe(value => events.push(['last', value]), { callWithLast: true });
  watched.subscribe(value => events.push(['plain', value]));
  watched.setValue(3);
  watched.setValue(3, true);
  watched.unsubscribe(null);
  watched.setValue(4);
  assert.deepEqual(events, [['last', 3], ['last', 3], ['plain', 3]]);
  assert.equal(watched.value(), 4);
  scope.destroy();
});

test('U08/U06: IWatchedValueReadonly subscribe and IWatchedValueReadonly unsubscribe(callback) follow changes until removed', () => {
  const { scope, factory } = brokerFactory();
  const watched = factory.createWatchedValue(0), seen = [];
  const listener = value => seen.push(value);
  watched.subscribe(listener);
  watched.setValue(1); watched.setValue(2);
  watched.unsubscribe(listener);
  watched.setValue(3);
  assert.deepEqual(seen, [1, 2]);
  scope.destroy();
});

test('U08/U06: WatchedValueSubscribeOptions once removes the subscription after the first update', () => {
  const { scope, factory } = brokerFactory();
  const watched = factory.createWatchedValue(0), seen = [];
  watched.subscribe(value => seen.push(value), { once: true });
  watched.setValue(1); watched.setValue(2);
  assert.deepEqual(seen, [1]);
  scope.destroy();
});

test('U08/U06: IWatchedValueReadonly when fires once when the value is or becomes true (once and callWithLast implied)', () => {
  const { scope, factory } = brokerFactory();
  const pending = factory.createWatchedValue(false), ready = factory.createWatchedValue(true), seen = [];
  pending.when(value => seen.push(['pending', value]));
  pending.setValue(false, true);
  assert.deepEqual(seen, []);
  pending.setValue(true); pending.setValue(false); pending.setValue(true);
  ready.when(value => seen.push(['ready', value]));
  ready.setValue(true, true);
  assert.deepEqual(seen, [['pending', true], ['ready', true]]);
  scope.destroy();
});

test('U08/U06: IDelegate fire evokes ISubscription subscribe callbacks with obj as this, singleshot removes after one fire, ISubscription unsubscribe matches obj and member', () => {
  const { scope, factory } = brokerFactory();
  const delegate = factory.createDelegate(), owner = { total: 0 }, other = { total: 0 };
  function add(amount) { this.total += amount; }
  const once = [];
  delegate.subscribe(owner, add);
  delegate.subscribe(other, add);
  delegate.subscribe(null, value => once.push(value), true);
  delegate.fire(2);
  delegate.unsubscribe(owner, add);
  delegate.unsubscribe(other, () => {});
  delegate.fire(3);
  assert.equal(owner.total, 2);
  assert.equal(other.total, 5);
  assert.deepEqual(once, [2]);
  scope.destroy();
});

test('U08/U06: IFormatter format and INumberFormatter format render numbers; IFormatter parse returns FormatterParseResult res with SuccessFormatterParseResult value or ErrorFormatterParseResult error', () => {
  const formatter = createNumericFormatter('en-US', 2);
  assert.equal(formatter.format(1234.5), '1234.50');
  assert.equal(formatter.format(undefined), '');
  const success = formatter.parse('12.5');
  assert.equal(success.res, true);
  assert.equal(success.value, 12.5);
  const failure = formatter.parse('twelve');
  assert.equal(failure.res, false);
  assert.equal(typeof failure.error, 'string');
  assert(failure.error.length > 0);
  assert.equal('value' in failure, false);
});

test('U08/U06: IPriceFormatter format snaps to the tick; ISymbolValueFormatter format assigns + and - signs; PriceFormatterFormatOptions tailSize and useRtlFormat', () => {
  const price = createPriceFormatter('en-US', 100, 5);
  assert.equal(price.format(1.234), '1.25');
  assert.equal(price.format(2, { signPositive: true }), '+2.00');
  assert.equal(price.format(-2, { signPositive: true }), '-2.00');
  assert.equal(price.format(2), '2.00');
  const exact = createPriceFormatter('en-US', 100, 1, false, 0, undefined, false);
  assert.equal(exact.format(1.23456, { tailSize: 2 }), '1.2346');
  assert.equal(exact.format(-1.5, { useRtlFormat: true }), '⁧-1.50⁩');
});

test('U05/U06/U07: CustomTableElementFormatter name selects the custom formatter for the column and TableFormatterInputs values follow dataFields order', async () => {
  const calls = [];
  const cells = await exportCells(
    [{ id: 'A', qty: 2, extra: { note: 'x' } }],
    [{ id: 'c', label: 'C', dataFields: [['extra', 'note'], 'qty'], formatter: 'myQty' }, { id: 'p', label: 'P', dataFields: ['qty'], formatter: 'fixed' }],
    { custom: [{ name: 'other', formatText: () => assert.fail('wrong name') }, { name: 'myQty', formatText: inputs => { calls.push(inputs.values); return `${inputs.values[1]}/${inputs.values[0]}`; } }] },
  );
  assert.deepEqual(calls, [['x', 2]]);
  assert.deepEqual(cells, [['2/x', '2.00']]);
});

test('U05/U06/U07: CustomTableElementFormatter isPriceFormatterNeeded delivers the row symbol price formatter; formatters without it receive none', async () => {
  const seen = [];
  const cells = await exportCells(
    [{ id: 'A', symbol: 'X', avgPrice: 1.234 }],
    [{ id: 'p', label: 'P', dataFields: ['avgPrice'], formatter: 'withPrice' }, { id: 'q', label: 'Q', dataFields: ['avgPrice'], formatter: 'plain' }],
    { custom: [
      { name: 'withPrice', isPriceFormatterNeeded: true, formatText: inputs => { seen.push('priceFormatter' in inputs); return inputs.priceFormatter.format(inputs.values[0]); } },
      { name: 'plain', formatText: inputs => { seen.push('priceFormatter' in inputs); return String(inputs.values[0]); } },
    ] },
  );
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(cells, [[services.price.format(1.234), '1.234']]);
});

test('U05/U06/U07: StandardFormattersDependenciesMapping [StandardFormatterName.Default] joins every FieldRef and [StandardFormatterName.Empty] renders nothing without dependencies', async () => {
  const cells = await exportCells(
    [{ id: 'A', broker: 'Demo', extra: { desk: 'FX' } }],
    [{ id: 'd', label: 'D', dataFields: ['broker', ['extra', 'desk']], formatter: 'default' }, { id: 'e', label: 'E', dataFields: [], formatter: 'empty' }],
  );
  assert.deepEqual(cells, [['Demo FX', '']]);
});

test('U05/U06/U07: StandardFormattersDependenciesMapping [StandardFormatterName.Side] and [StandardFormatterName.Status] read their single property', async () => {
  const cells = await exportCells(
    [{ id: 'A', side: 1, status: 6 }, { id: 'B', side: -1, status: 2 }],
    [{ id: 's', label: 'S', dataFields: ['side'], formatter: 'side' }, { id: 't', label: 'T', dataFields: ['status'], formatter: 'status' }],
  );
  assert.deepEqual(cells, [['Buy', 'Working'], ['Sell', 'Filled']]);
});

test('U05/U06/U07: StandardFormattersDependenciesMapping [StandardFormatterName.Type] reads orderType, parentId and stopType dependencies', async () => {
  const cells = await exportCells(
    [
      { id: 'A', type: 1 },
      { id: 'B', type: 4 },
      { id: 'C', type: 3, parentId: 'A', stopType: 1 },
      { id: 'D', type: 3, parentId: 'A', stopType: 2 },
    ],
    [{ id: 'type', label: 'Type', dataFields: ['type', 'parentId', 'stopType'], formatter: 'type' }],
  );
  assert.deepEqual(cells.map(([text]) => text), ['Limit', 'Stop-limit', 'Trailing stop', 'Guaranteed stop']);
});

test('U05/U06/U07: StandardFormattersDependenciesMapping [StandardFormatterName.LocalDate] uses the environment timezone for its date property', async () => {
  const at = Date.UTC(2024, 0, 1, 23, 30, 0);
  const columns = [{ id: 'l', label: 'L', dataFields: ['time'], formatter: 'localDate' }, { id: 'u', label: 'U', dataFields: ['time'], formatter: 'date' }];
  const [[local, utc]] = await exportCells([{ id: 'A', time: at }], columns, { timezone: 'Asia/Tokyo' });
  assert.match(local, /01\/02\/2024/);
  assert.match(utc, /01\/01\/2024/);
});

test('U05/U06/U07/P03: StandardFormattersDependenciesMapping [StandardFormatterName.Pips] and [StandardFormatterName.Percentage] format their value property', async () => {
  const cells = await exportCells(
    [{ id: 'A', pips: 12.5, pct: 3.456 }],
    [{ id: 'p', label: 'P', dataFields: ['pips'], formatter: 'pips' }, { id: 'c', label: 'C', dataFields: ['pct'], formatter: 'percentage' }],
  );
  assert.deepEqual(cells, [['12.5 pips', '3.46%']]);
});

test('U08/U06: SymbolFormatterProperties base [displayName, symbol] prefers the display name and LevelsFormatterProperties base [price] formats a single exit level', async () => {
  const cells = await exportCells(
    [{ id: 'A', symbol: 'FX:EURUSD', display: 'EURUSD', tp: 1.2345 }, { id: 'B', symbol: 'FX:GBPUSD', tp: 2 }],
    [{ id: 's', label: 'S', dataFields: ['display', 'symbol'], formatter: 'symbol' }, { id: 't', label: 'TP', dataFields: ['tp'], formatter: 'formatExitLevels' }],
  );
  assert.deepEqual(cells, [['EURUSD', '1.23'], ['FX:GBPUSD', '2.00']]);
});
