import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { entityReader, valueReader } = await loadModule('src/core/readers.ts');
const { EntityStore } = await loadModule('src/core/entity-store.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
test('A05: read-only consumer failures cannot stop later entity or value notifications', () => {
  const entities = new EntityStore(() => {}), values = new ValueStore(0);
  try {
    const entity = entityReader(entities), value = valueReader(values), seen = [];
    entity.subscribeChanges(() => { throw Error('consumer failed'); });
    entity.subscribeChanges(change => seen.push(['entity', change.revision]));
    value.subscribe(() => { throw Error('consumer failed'); });
    value.subscribe(next => seen.push(['value', next]));
    assert.doesNotThrow(() => entities.upsert({ id: 'A', value: 1 }));
    assert.doesNotThrow(() => values.set(1));
    assert.equal(entity.get('A').value, 1); assert.equal(entity.revision('A'), 1);
    assert.deepEqual(seen, [['entity', 1], ['value', 1]]);
  } finally { entities.destroy(); values.destroy(); }
});
test('A05: consumer release during publication is immediate and repeated release is harmless', () => {
  for (const kind of ['entity', 'value']) {
    const store = kind === 'entity' ? new EntityStore(() => {}) : new ValueStore(0), reader = kind === 'entity' ? entityReader(store) : valueReader(store);
    const subscribe = kind === 'entity' ? reader.subscribeChanges : reader.subscribe;
    let release, deliveries = 0;
    subscribe(() => { release(); release(); });
    release = subscribe(() => { deliveries++; });
    if (kind === 'entity') store.upsert({ id: 'A' }); else store.set(1);
    assert.equal(deliveries, 0, 'removed consumer must not run from the publication snapshot');
    store.destroy();
  }
});
test('A05: destroying a producer during publication prevents later consumer calls', () => {
  for (const kind of ['entity', 'value']) {
    const store = kind === 'entity' ? new EntityStore(() => {}) : new ValueStore(0), reader = kind === 'entity' ? entityReader(store) : valueReader(store);
    const subscribe = kind === 'entity' ? reader.subscribeChanges : reader.subscribe;
    let deliveries = 0;
    subscribe(() => store.destroy());
    subscribe(() => { deliveries++; });
    if (kind === 'entity') store.upsert({ id: 'A' }); else store.set(1);
    assert.equal(deliveries, 0, 'disposed producer cannot notify another consumer');
    store.destroy();
  }
});
