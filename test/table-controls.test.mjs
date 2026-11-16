import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { matchesTableFilter, readColumnChoices, visibleTableColumns, serializeColumnChoices } = await loadModule('src/ui/account-manager/table-controls.ts');
const { createTableModel } = await loadModule('src/ui/account-manager/table-model.ts');
const { EntityStore } = await loadModule('src/core/entity-store.ts');
const columns = [{ id: 'symbol', dataFields: ['symbol'], notHideable: true }, { id: 'qty', dataFields: ['qty'] }, { id: 'extra', dataFields: [['extra','note']], hideByDefault: true }];
test('U06: filters combine status and case-insensitive raw dependent fields without formatting broker content', () => {
  const row = { id: 'A', symbol: 'SIM:X', qty: 2, status: 6, extra: { note: 'Primary' } };
  const filter = { status: 0, query: ' sim:x ', fields: ['id','symbol',['extra','note']] };
  assert.equal(matchesTableFilter(row, filter), true);
  assert.equal(matchesTableFilter(row, { ...filter, status: 2 }), false);
  assert.equal(matchesTableFilter(row, { ...filter, status: 6, query: 'PRIMARY' }), true);
  assert.equal(matchesTableFilter(row, { ...filter, query: 'missing' }), false);
});
test('U06: column choices preserve defaults and mandatory columns, ignore malformed/unknown stored values and round trip', () => {
  const choices = readColumnChoices(JSON.stringify({ version: 1, columns: [['symbol',false],['qty',false],['extra',true],['unknown',true],['qty','wrong']] }), columns);
  assert.deepEqual(visibleTableColumns(columns, choices).map(column => column.id), ['symbol','extra']);
  const encoded = serializeColumnChoices(columns, choices);
  assert.deepEqual(JSON.parse(encoded), { version: 1, columns: [['qty',false],['extra',true]] });
  assert.deepEqual(visibleTableColumns(columns, readColumnChoices(encoded,columns)).map(column => column.id), ['symbol','extra']);
  for (const invalid of ['broken', JSON.stringify({ version: 2, columns: [['qty',false]] }), JSON.stringify({ version: 1, columns: [] })])
    assert.deepEqual(visibleTableColumns(columns, readColumnChoices(invalid,columns)).map(column => column.id), ['symbol','qty']);
});
test('U06/X09: an active status/search filter inspects only a changed row during a financial push', () => {
  const store = new EntityStore(() => {});
  store.replace(Array.from({ length: 10000 }, (_, index) => ({ id: String(index), symbol: 'SIM:X', status: 6, qty: index })));
  let reads = 0;
  const reader = { ids: () => store.ids(), get: id => { reads++; return store.get(id); }, subscribeChanges: listener => store.subscribeChanges(listener) };
  const model = createTableModel(reader);
  try {
    const filter = { query: 'SIM', status: 6, fields: ['symbol'] };
    model.setFilter(row => matchesTableFilter(row, filter));
    const ids = model.ids.get(); reads = 0;
    store.patch('42', { qty: 43 });
    assert.equal(reads, 1); assert.equal(model.ids.get(), ids);
    store.patch('42', { status: 2 });
    assert(!model.ids.get().includes('42'));
  } finally { model.destroy(); store.destroy(); }
});

test('U06/U09: oversized column choices fail saving instead of claiming persistence that cannot be reloaded', () => {
  const id = 'column'.repeat(6000), columns = [{ id, dataFields: ['qty'] }];
  assert.throws(() => serializeColumnChoices(columns, new Map([[id,false]])), /Too many/);
});
