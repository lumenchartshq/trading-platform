import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { createCapabilityPolicy } = await loadModule('src/core/capability-policy.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');

function fixture(broker = { positions() {}, closePosition() {} }) {
  let resolves = 0;
  const revision = new ValueStore(0), symbolOptions = new Map();
  const owner = createCapabilityPolicy({
    config: { configFlags: { supportPositions: true, supportReversePosition: true } },
    context: () => ({ broker }),
    catalog: { options: symbol => symbolOptions.get(symbol), revision },
    resolve: (...args) => { resolves++; return resolveCapabilities(...args); },
  });
  return { owner, revision, symbolOptions, resolves: () => resolves };
}
test('X09: symbol policies are memoised; repeated quote-path reads resolve nothing after warm-up', () => {
  const { owner, resolves } = fixture();
  owner.symbolPolicy('X'); owner.symbolPolicy();
  const warm = resolves();
  for (let tick = 0; tick < 50; tick++) for (let position = 0; position < 5; position++) {
    owner.symbolPolicy('X').flags.supportReversePosition;
    owner.symbolPolicy('X').flags.positionPLInInstrumentCurrency;
  }
  assert.equal(resolves() - warm, 0);
  assert.equal(owner.symbolPolicy('X'), owner.symbolPolicy('X'));
  owner.destroy();
});
test('U01/X09: the memo invalidates on patches, durations and symbol-options revisions', () => {
  const { owner, revision, symbolOptions } = fixture();
  assert.equal(owner.symbolPolicy('X').flags.supportReversePosition, true);
  owner.patchConfig({ supportReversePosition: false });
  assert.equal(owner.symbolPolicy('X').flags.supportReversePosition, false, 'a patch is visible at once');
  symbolOptions.set('X', { supportReversePosition: true });
  assert.equal(owner.symbolPolicy('X').flags.supportReversePosition, false, 'options apply only with their revision');
  revision.set(1);
  assert.equal(owner.symbolPolicy('X').flags.supportReversePosition, true);
  owner.setDurations([{ name: 'Day', value: 'DAY' }]);
  assert.deepEqual(owner.symbolPolicy('X').durations.map(value => value.value), ['DAY']);
  assert.deepEqual(owner.resolveAccount().durations.map(value => value.value), ['DAY']);
  owner.destroy();
});
test('U01: a policy resolved before the broker exists is not kept', () => {
  let broker;
  let resolves = 0;
  const owner = createCapabilityPolicy({
    context: () => ({ broker }),
    catalog: { options: () => undefined, revision: new ValueStore(0) },
    resolve: (...args) => { resolves++; return resolveCapabilities(...args); },
  });
  owner.symbolPolicy('X'); owner.symbolPolicy('X');
  assert.equal(resolves, 3, 'initial account policy plus two uncached reads');
  broker = {}; owner.symbolPolicy('X'); owner.symbolPolicy('X');
  assert.equal(resolves, 4);
  owner.destroy();
});
