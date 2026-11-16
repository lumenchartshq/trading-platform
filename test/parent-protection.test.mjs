import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { completeParentProtection } = await loadModule('src/core/parent-protection.ts');
const { validateBracketEditInput } = await loadModule('src/core/bracket-modification.ts');
const { OrderType, StopType, Side, ParentType } = await loadModule('src/contracts/broker.ts');
const child = (id, level, type, price, qty = 1) => ({id, parentId: 'p', parentType: ParentType.Position, exitLevelId: level, symbol: 'SIM:X', side: Side.Sell, type, qty, ...(type === OrderType.Limit ? {limitPrice: price} : {stopPrice: price})});
test('B04: absent parent metadata is reconstructed from broker-owned child level identities without expanding protection', () => {
  const parent = {qty: 8}, children = [child('tp1', 'one', OrderType.Limit, 103), child('sl1', 'one', OrderType.Stop, 99), child('tp2', 'two', OrderType.Limit, 104, 2), {...child('sl2', 'two', OrderType.Stop, 98, 2), stopType: StopType.GuaranteedStop}];
  const before = structuredClone(children), result = completeParentProtection(parent, children);
  assert.equal(result.qty, 8);
  assert.deepEqual(result.exitLevels, [{id: 'one', qty: 1, takeProfit: 103, stopLoss: 99, isExisting: true}, {id: 'two', qty: 2, takeProfit: 104, guaranteedStop: 98, isExisting: true}]);
  assert.deepEqual(children, before); assert.deepEqual(parent, {qty: 8});
});
test('B04: unnamed full-size legacy children remain legacy, but ambiguous partial and duplicate data reject', () => {
  const tp = child('tp', undefined, OrderType.Limit, 103, 4), sl = child('sl', undefined, OrderType.Stop, 99, 4);
  assert.deepEqual(completeParentProtection({qty: 4}, [tp, sl]), {qty: 4, takeProfit: 103, stopLoss: 99});
  for (const children of [[{...tp, qty: 2}], [tp, {...sl, qty: 2}], [tp, {...tp, id: 'duplicate'}], []])
    assert.throws(() => completeParentProtection({qty: 4}, children), {code: 'stale-context'});
});
test('B05: distance-only trailing children preserve their distance when the provider has no static stop price', () => {
  const trailing = {...child('trail', 'one', OrderType.Stop, undefined), stopType: StopType.TrailingStop, trailingStopPips: 25};
  const instrument = {qty: {min: 1, max: 100, step: 1}, minTick: 0.01, pipSize: 0.01, pipValue: 1};
  validateBracketEditInput(trailing, instrument);
  assert.equal(completeParentProtection({qty: 4}, [trailing]).exitLevels[0].trailingStopPips, 25);
  assert.throws(() => validateBracketEditInput({...trailing, trailingStopPips: 0}, instrument), /positive trailing/);
});
test('B04: partial aggregate metadata is completed from active children instead of dropping a proven leg', () => {
  const tp = child('tp', 'single', OrderType.Limit, 103, 4), sl = child('sl', 'single', OrderType.Stop, 99, 4);
  assert.deepEqual(completeParentProtection({qty: 4, takeProfit: 103}, [tp, sl]), {qty: 4, takeProfit: 103, stopLoss: 99});
  const levels = {qty: 4, exitLevels: [{id: 'one', qty: 3, takeProfit: 103}, {id: 'two', qty: 1, takeProfit: 104, stopLoss: 98}]};
  const merged = completeParentProtection(levels, [child('tp1', 'one', OrderType.Limit, 103, 3), child('sl1', 'one', OrderType.Stop, 99, 3)]);
  assert.deepEqual(merged.exitLevels, [{id: 'one', qty: 3, takeProfit: 103, stopLoss: 99}, levels.exitLevels[1]]);
  assert.equal(levels.exitLevels[0].stopLoss, undefined, 'provider metadata is not mutated');
});
test('B04: hybrid metadata that contradicts active children rejects instead of overwriting or recreating legs', () => {
  const tp = child('tp', 'single', OrderType.Limit, 103, 4);
  const trailing = {...child('trail', 'single', OrderType.Stop, 98, 4), stopType: StopType.TrailingStop, trailingStopPips: 25};
  for (const [parent, children] of [
    [{qty: 4, takeProfit: 105}, [tp]],
    [{qty: 4, stopLoss: 99}, [trailing]],
    [{qty: 4, takeProfit: 103}, [{...tp, qty: 2}]],
    [{qty: 4, exitLevels: [{id: 'one', qty: 4, takeProfit: 103}]}, [child('x', 'missing', OrderType.Stop, 99, 4)]],
    [{qty: 4, exitLevels: [{id: 'one', qty: 3, takeProfit: 103}]}, [child('x', 'one', OrderType.Stop, 99, 2)]],
  ]) assert.throws(() => completeParentProtection(parent, children), {code: 'stale-context'});
});
test('B05: a broker-reported off-grid trailing price does not block a distance edit', () => {
  const trailing = {...child('trail', 'one', OrderType.Stop, 99.875), stopType: StopType.TrailingStop, trailingStopPips: 20};
  validateBracketEditInput(trailing, {qty: {min: 1, max: 100, step: 1}, minTick: 0.01, pipSize: 0.01, pipValue: 1});
});
