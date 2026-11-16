import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { createTradingState } = await loadModule('src/core/trading-state.ts');
const { assertLiveContext, assertRevision, entityStore, isLiveContext } = await loadModule('src/core/command-context.ts');

test('O03/A03: command context rejects closed, disconnected and replaced accounts in order', () => {
  const state = createTradingState();
  const context = { accountId: 'A', generation: 2 };
  for (const [phase, accountId, generation, code] of [
    ['disposed', 'B', 3, 'disposed'],
    ['switching', 'B', 3, 'disconnected'],
    ['ready', 'B', 2, 'stale-context'],
    ['ready', 'A', 3, 'stale-context'],
    ['ready', 'A', 2, undefined],
  ]) {
    state.connection.set({ ...state.connection.get(), phase, accountId, generation });
    assert.equal(isLiveContext(state, context), code === undefined);
    if (code) assert.throws(() => assertLiveContext(state, context), error => error.code === code);
    else assert.doesNotThrow(() => assertLiveContext(state, context));
  }
});

test('O03/C03: revisions belong to the selected entity store and reject changes or removal', () => {
  const state = createTradingState();
  const entities = {
    order: { id: 'same', symbol: 'X', side: 1, qty: 1, type: 1, status: 6 },
    position: { id: 'same', symbol: 'X', side: 1, qty: 1, avgPrice: 10 },
    individualPosition: { id: 'same', symbol: 'X', side: 1, qty: 1, price: 10, date: 0 },
  };
  for (const [kind, entity] of Object.entries(entities)) {
    const store = entityStore(state, kind);
    store.upsert(entity);
    const revision = store.revision(entity.id);
    assert.doesNotThrow(() => assertRevision(state, kind, entity.id, revision));
    store.upsert({ ...entity, qty: 2 });
    assert.throws(() => assertRevision(state, kind, entity.id, revision), error => error.code === 'stale-context');
    const next = store.revision(entity.id);
    store.remove(entity.id);
    assert.throws(() => assertRevision(state, kind, entity.id, next), error => error.code === 'stale-context');
  }
});
test('O03: an entity command without a captured revision is invalid input, not a changed entity', async () => {
  const { assertRevision } = await loadModule('src/core/command-context.ts');
  const state = { orders: { revision: () => 1 }, positions: { revision: () => 1 }, individualPositions: { revision: () => 1 } };
  assert.throws(() => assertRevision(state, 'order', 'A', undefined), error => error.code === 'invalid-input');
  assert.throws(() => assertRevision(state, 'order', 'A', 0), error => error.code === 'stale-context');
  assert.doesNotThrow(() => assertRevision(state, 'order', 'A', 1));
});
