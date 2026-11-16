import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
const { OverlayIndex } = await loadModule('src/chart/overlay-index.ts');
const projection = (kind, id, symbol, specKind = kind) => ({ kind, id, revision: 1, spec: { kind: specKind, symbol, key: `${kind}:${id}` } });

test('X09/B06: the index tracks projections, exits and positions per symbol and moves keys between symbols', () => {
  const index = new OverlayIndex();
  index.set('order', 'TP', 'order:TP', projection('order', 'TP', 'A', 'bracket'));
  index.set('position', 'P', 'position:P', projection('position', 'P', 'A'));
  assert.deepEqual([...index.projections('A').keys()], ['order:TP', 'position:P']);
  assert.equal(index.hasExits('A'), true); assert.equal(index.hasPositions('A'), true);
  assert.equal(index.set('order', 'TP', 'order:TP', projection('order', 'TP', 'B', 'bracket')), 'A');
  assert.equal(index.hasExits('A'), false); assert.deepEqual([...index.exitIds('B')], ['TP']);
  assert.equal(index.set('position', 'P', 'position:P', undefined), 'A');
  assert.equal(index.hasPositions('A'), false); assert.equal(index.projections('A').size, 0);
  assert.deepEqual(index.indexedIds('order'), ['TP']);
});
test('B06/X09: removing one of 10000 indexed orders touches only its symbol and leaves no empty buckets', () => {
  const index = new OverlayIndex();
  for (let i = 0; i < 10000; i++) index.set('order', `O${i}`, `order:O${i}`, projection('order', `O${i}`, `S${i % 100}`, i % 2 ? 'bracket' : 'order'));
  assert.equal(index.projections('S7').size, 100);
  index.set('order', 'O7', 'order:O7', undefined);
  assert.equal(index.projections('S7').size, 99);
  assert.equal(index.exitIds('S7').has('O7'), false);
  for (let i = 7; i < 10000; i += 100) index.set('order', `O${i}`, `order:O${i}`, undefined);
  assert.equal(index.projections('S7').size, 0); assert.equal(index.hasExits('S7'), false);
});
test('B04: market parents are indexed by symbol and leave the index when they stop being market orders', () => {
  const index = new OverlayIndex();
  index.indexMarketParent('M', { id: 'M', symbol: 'A', type: 2 });
  index.indexMarketParent('L', { id: 'L', symbol: 'A', type: 1 });
  assert.deepEqual([...index.marketParents('A')], ['M']);
  index.indexMarketParent('M', { id: 'M', symbol: 'A', type: 1 });
  assert.equal(index.marketParents('A').size, 0);
  index.indexMarketParent('M', { id: 'M', symbol: 'B', type: 2 }); index.indexMarketParent('M', undefined);
  assert.equal(index.marketParents('B').size, 0);
});
