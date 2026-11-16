import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { createDockSizes } = await loadModule('src/ui/dock-sizes.ts');
test('U09: normal dock sizes survive remount, reject invalid storage and keep live resizing on save failure', () => {
  const values = new Map(), errors = [];
  let fail = false;
  const preferences = { get: key => values.get(key), set(key, value) { if (fail) throw new Error('Storage unavailable'); values.set(key, value); } };
  let sizes = createDockSizes(preferences, error => errors.push(error));
  sizes.resize('right', 400); sizes.save('right'); sizes.resize('accounts', 370); sizes.save('accounts'); sizes.destroy();
  sizes = createDockSizes(preferences, error => errors.push(error));
  assert.equal(sizes.right.get(), 400); assert.equal(sizes.accounts.get(), 370);
  fail = true; sizes.resize('right', 470); sizes.save('right'); assert.equal(sizes.right.get(), 470); assert.equal(errors.length, 1);
  sizes.destroy(); sizes.resize('right', 280); sizes.save('right'); assert.equal(sizes.right.get(), 470); assert.equal(errors.length, 1);
  for (const invalid of ['bad', JSON.stringify({ version: 2, pixels: 350 }), JSON.stringify({ version: 1, pixels: '350' }), ' '.repeat(81)]) {
    values.set('dock.right', invalid); const next = createDockSizes(preferences, () => {}); assert.equal(next.right.get(), 320); next.destroy();
  }
});
