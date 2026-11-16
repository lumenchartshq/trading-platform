import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './load-module.mjs';
const { overlaySpecPatch, projectOverlay } = await loadModule('src/chart/overlay-projection.ts');
const { mapContextActions } = await loadModule('src/chart/context-actions.ts');
const { resolveCapabilities } = await loadModule('src/core/capabilities.ts');
const { resolveTradingFeatures } = await loadModule('src/core/features.ts');
const context = overrides => ({
  visible: true, ready: true, compact: false,
  flags: resolveCapabilities({ configFlags: { supportPositions: true, supportExecutions: true, supportPositionBrackets: true } }).flags,
  features: resolveTradingFeatures(),
  parentAvailable: () => true, priceEditable: () => true, reversible: () => true,
  profitLabel: () => '+12.00 USD', ...overrides,
});
const order = { id: 'O', symbol: 'X', side: 1, qty: 2, type: 1, status: 6, limitPrice: 100 };
const position = { id: 'P', symbol: 'X', side: 1, qty: 2, avgPrice: 100 };

test('O03/B01: pure order projections preserve actionable prices and hide terminal or orphaned protection', () => {
  const projected = projectOverlay('order', order, 3, context());
  assert.equal(projected.revision, 3);
  assert.equal(projected.spec.label, 'Buy Limit');
  assert.equal(projectOverlay('order', { ...order, type: 2, avgPrice: 100 }, 3, context()).spec.label, 'Buy');
  assert.equal(projectOverlay('order', { ...order, type: 2, side: -1, avgPrice: 100 }, 3, context()).spec.label, 'Sell');
  assert.equal(projectOverlay('order', { ...order, type: 3, stopPrice: 100 }, 3, context()).spec.label, 'Buy Stop');
  assert.deepEqual(projected.spec.actions, ['cancel', 'modify']);
  for (const status of [1, 2, 5]) assert.equal(projectOverlay('order', { ...order, status }, 3, context()), undefined);
  const child = { ...order, parentId: 'P', parentType: 2, side: -1 };
  assert.equal(projectOverlay('order', child, 3, context({ parentAvailable: () => false })), undefined);
  const bracket = projectOverlay('order', child, 3, context({ parentRevision: 7 }));
  assert.equal(bracket.parentRevision, 7); assert.equal(bracket.spec.kind, 'bracket');
  assert.deepEqual(projectOverlay('order', order, 3, context({ ready: false })).spec.actions, []);
});

test('P01/U01: pure position projections respect adaptive lines, readiness, hiding and per-symbol reverse', () => {
  const normal = projectOverlay('position', position, 1, context());
  assert.equal(normal.spec.label, 'Long 2 · +12.00 USD');
  assert.deepEqual(normal.spec.actions, ['close', 'reverse', 'protect']);
  const compact = projectOverlay('position', position, 1, context({ compact: true, profitLabel: () => assert.fail('compact lines must not request profit') }));
  assert.equal(compact.spec.label, 'Long 2');
  assert.deepEqual(compact.spec.actions, ['close', 'reverse']);
  assert.deepEqual(projectOverlay('position', position, 1, context({ reversible: () => false })).spec.actions, ['close', 'protect']);
  assert.equal(projectOverlay('position', position, 1, context({ visible: false })), undefined);
  assert.equal(projectOverlay('position', { ...position, qty: 0 }, 1, context()), undefined);
});

test('O06: pure execution projections convert broker milliseconds to chart seconds', () => {
  const projection = projectOverlay('execution', { id: 'E', symbol: 'X', side: -1, qty: 1, price: 101, time: 12000 }, 2, context());
  assert.equal(projection.spec.time, 12); assert.equal(projection.spec.label, 'Sold 1');
  assert.deepEqual(projection.spec.actions, []);
});

test('U05/X01: broker menu mapping skips malformed entries and defers custom action execution', () => {
  let ran = 0;
  const action = { text: 'Broker action', enabled: false, action(value) { assert.equal(value, action); ran++; } };
  const entries = mapContextActions([null, 'bad', { text: 'No callback' }, { separator: true }, action], side => ({ text: String(side) }));
  assert.equal(ran, 0); assert.deepEqual(entries[0], { separator: true });
  assert.equal(entries[1].enabled, false); entries[1].run(); assert.equal(ran, 1);
});

test('OC05/OC11: live order and position protection carries the profit direction after reversal', () => {
  for (const side of [1, -1]) {
    const flags = { ...context().flags, supportAddBracketsToExistingOrder: true };
    const projectedOrder = projectOverlay('order', { ...order, side }, 1, context({ flags, protectionEditable: () => true }));
    assert.equal(projectedOrder.spec.protection.profitDirection, side);
    const projectedPosition = projectOverlay('position', { ...position, side }, 1, context());
    assert.equal(projectedPosition.spec.protection.profitDirection, side);
  }
});

test('PH02: broker position pill separates accessible side/quantity from signed profit', () => {
  const options = context({ profitLabel: () => '12.00 USD', profitTone: () => 'positive' });
  const projected = projectOverlay('position', { id: 'pill', symbol: 'X', side: 1, qty: 2, avgPrice: 100 }, 1, options);
  assert.equal(projected.spec.label, 'Long 2 · 12.00 USD');
  assert.deepEqual(projected.spec.pill, { text: '+12.00 USD', tone: 'positive' });
});

test('OC12: an overlay update sends exactly the spec fields that changed, cleared ones as explicit undefined', () => {
  const base = {
    kind: 'bracket', key: 'order:1', entityId: '1', symbol: 'A', side: -1, group: 'position:p',
    price: 10, label: 'Sell Limit', tooltip: 'Take Profit', quantity: 1, actions: ['modify'],
    pill: { text: '+1' }, protection: { handles: [] }, style: { lineWidth: 1 },
  };
  assert.deepEqual(overlaySpecPatch(base, { ...base }), {});
  const changed = {
    price: 11, label: 'Sell Stop', tooltip: 'Stop Loss', quantity: 2, actions: ['cancel'],
    pill: { text: '-1' }, protection: { handles: ['takeProfit'] }, style: { lineWidth: 2 },
  };
  for (const [field, value] of Object.entries(changed))
    assert.deepEqual(overlaySpecPatch(base, { ...base, [field]: value }), { [field]: value }, field);
  const cleared = overlaySpecPatch(base, { ...base, tooltip: undefined, pill: undefined });
  assert.deepEqual(Object.keys(cleared).sort(), ['pill', 'tooltip']);
  assert.equal(cleared.tooltip, undefined);
  assert.deepEqual(overlaySpecPatch(base, { ...base, group: 'other', side: 1 }), {}, 'fixed fields are not patched');
});
test('X04/B06: overlay keys have one spelling shared with command lock keys', async () => {
  const { overlayKey } = await loadModule('src/chart/overlay-projection.ts');
  const { commandKeys } = await loadModule('src/core/command-keys.ts');
  assert.equal(overlayKey('order', 'A:1'), commandKeys.order('A:1'));
  assert.equal(overlayKey('individualPosition', 'P'), commandKeys.position('P', true));
  assert.equal(overlayKey('execution', 'E'), 'execution:E');
});
