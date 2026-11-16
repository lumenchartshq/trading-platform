import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
import { deferred } from './manual-clock.mjs';
const { accountPage, accountPages } = await loadModule('src/ui/account-manager/account-pages.ts');
const { createRowActionTracker } = await loadModule('src/ui/account-manager/row-action-tracker.ts');
const { formatAccountValue } = await loadModule('src/ui/account-manager/format-account-value.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const { resolveTradingFeatures } = await loadModule('src/core/features.ts');
const { StandardFormatterName } = await loadModule('src/contracts/broker.ts');
const { sameAccountGeneration, sameBinding, bindingKey } = await loadModule('src/core/identity.ts');

test('U05/U06: account page descriptors preserve columns, sorting, status filters and feature visibility', () => {
  const columns = [{ id: 'id' }], positions = [{ id: 'qty' }], sorting = [{ property: 'id', asc: true }];
  const metadata = { orderColumns: columns, positionColumns: positions, orderColumnsSorting: sorting };
  assert.equal(accountPage('individual').columns(metadata), positions);
  assert.equal(accountPage('history').columns(metadata), columns);
  assert.equal(accountPage('orders').sorting(metadata), sorting);
  assert.equal(accountPage('history').sorting(metadata), undefined);
  assert.equal(accountPage('individual').reader, 'individualPositions');
  assert.equal(accountPage('history').actions, undefined);
  const flags = { ...resolveCapabilities().flags, supportPositions: true, supportPositionNetting: true, supportOrdersHistory: true, showNotificationsLog: true };
  assert.deepEqual(accountPages.filter(page => page.enabled(flags, resolveTradingFeatures())).map(page => page.id), ['positions', 'individual', 'orders', 'history', 'notifications']);
  assert.equal(accountPage('positions').title(flags), 'Net positions');
  assert.equal(accountPage('notifications').enabled(flags, resolveTradingFeatures([], ['show_trading_notifications_history'])), false);
});

test('U05/A03: row actions publish pending state and suppress old-account completion, errors and status', async () => {
  let current = { accountId: 'A', generation: 1 }, pending = new Set(), error, status;
  const tracker = createRowActionTracker({ current: () => current, pending: value => { pending = value; }, error: value => { error = value; }, status: value => { status = value; } });
  const old = deferred(), next = deferred();
  const first = tracker.run('same', current, async report => { await old.promise; report('old'); throw new Error('old error'); }, 'fallback');
  assert(pending.has('same'));
  current = { accountId: 'B', generation: 2 }; tracker.reset();
  const second = tracker.run('same', current, () => next.promise, 'fallback');
  old.resolve(); await first;
  assert(pending.has('same')); assert.equal(error, undefined); assert.equal(status, undefined);
  next.resolve(); await second; assert.equal(pending.size, 0);
  await tracker.run('bad', current, async () => { throw 'failure'; }, 'fallback');
  assert.equal(error, 'fallback');
  tracker.destroy();
});

test('U06/U07: shared account formatting preserves standard metadata, custom text and element ownership', () => {
  const formatter = { format: value => Number(value).toFixed(2) };
  const context = { locale: 'en', timezone: 'UTC', price: formatter, quantity: formatter, numeric: formatter, integer: formatter, variable: formatter };
  assert.equal(formatAccountValue(StandardFormatterName.FormatPrice, [12], { context }).text, '12.00');
  let textCalls = 0;
  const custom = { formatText: input => { textCalls++; return String(input.values[0]); }, formatElement() {} };
  assert.equal(formatAccountValue('custom', [4], { custom, element: true }).text, '');
  assert.equal(textCalls, 0);
  assert.equal(formatAccountValue('custom', [4], { custom }).text, '4');
  assert.equal(textCalls, 1);
  assert.throws(() => formatAccountValue('custom', [], { custom: { formatText: () => 1 } }), error => error.code === 'invalid-input');
});

test('A03/X01: account and chart lifetime identity retain generation fences independently of symbols', () => {
  assert(sameAccountGeneration({ accountId: 'A', generation: 1 }, { accountId: 'A', generation: 1 }));
  assert(!sameAccountGeneration({ accountId: 'A', generation: 1 }, { accountId: 'B', generation: 1 }));
  const binding = { id: 'C', generation: 2, symbol: 'X' };
  assert(sameBinding(binding, { ...binding, symbol: 'Y' }));
  assert(!sameBinding(binding, { ...binding, generation: 3 }));
  assert(!sameBinding(undefined, binding));
  assert.equal(bindingKey(binding), 'C:2');
});
test('U06: empty-table wording belongs to the account page', async () => {
  const { accountPage, DEFAULT_EMPTY_MESSAGE } = await loadModule('src/ui/account-manager/account-pages.ts');
  assert.match(accountPage('positions').emptyMessage, /no open positions/);
  assert.equal(accountPage('individual').emptyMessage, accountPage('positions').emptyMessage);
  assert.equal(accountPage('orders').emptyMessage, undefined);
  assert.equal(DEFAULT_EMPTY_MESSAGE, 'There is no trading data here yet');
});
