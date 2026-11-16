import { mapSettings } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { ManualClock, flush } from "./manual-clock.mjs";
const { createOverlayCoordinator } = await loadModule(
  "src/chart/overlay-coordinator.ts",
);
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
const { createTradingSession } = await loadModule("src/core/session.ts");
const { OrderStatus, OrderType, ParentType, Side } = await loadModule('src/contracts/broker.ts');
const { ValueStore } = await loadModule("src/core/value-store.ts");
function fixture(options = {}) {
  const simulation = createDeterministicBroker({ profile: options.profile ?? "equity-net" }),
    settings = new Map();
  const session = createTradingSession({
    ...simulation,
    ...options,
    brokerFactory: host => {
      const broker = (options.brokerFactory ?? simulation.brokerFactory)(host);
      options.configureBroker?.(broker);
      return broker;
    },
    settings: mapSettings(settings),
    formatters: {
      defaultPrice: async () => ({ format: String }),
      numeric: async () => ({ format: String }),
      quantity: async () => ({ format: String }),
      createPriceFormatter: () => ({ format: String }),
      ...options.formatters,
    },
  });
  const charts = [],
    listeners = new Set();
  const collection = {
    charts: () => charts,
    activeChart: () => charts[0],
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  function chart(id) {
    const overlays = [],
      binding = new ValueStore({ id, generation: 1, symbol: "SIM:X" });
    const port = {
      binding,
      registerContextActions: provider => { port.contextActions = provider; return () => {}; },
      onTradeIntent: () => () => {},
      symbolContext: async () => ({}),
      createOverlay(spec) {
        options.inspectOverlay?.(spec);
        const callbacks = new Set(),
          overlay = {
            spec,
            updates: [],
            removed: false,
            cancels: 0,
            update(patch) {
              options.inspectPatch?.(spec, patch);
              this.updates.push(patch);
            },
            subscribe(callback) {
              callbacks.add(callback);
              return () => callbacks.delete(callback);
            },
            cancelInteraction() {
              this.cancels++;
            },
            remove() {
              this.removed = true;
            },
            fire(event) {
              for (const callback of [...callbacks]) callback(event);
            },
          };
        overlays.push(overlay);
        return overlay;
      },
    };
    charts.push(port);
    return { port, overlays, binding };
  }
  return {
    simulation,
    session,
    chart,
    collection,
    remove(port) {
      charts.splice(charts.indexOf(port), 1);
      for (const listener of listeners)
        listener({ type: "removed", binding: port.binding.get() });
    },
  };
}
test("X03/P01/X09: both charts project updates, share quote demand and ignore table-only PL", async () => {
  const f = fixture();
  await f.session.ready;
  const a = f.chart("A"),
    b = f.chart("B");
  const coordinator = createOverlayCoordinator(
    f.session,
    f.collection,
    () => {},
  );
  await flush();
  assert.equal(a.overlays.length, 1);
  assert.equal(b.overlays.length, 1);
  assert.equal(f.simulation.controls.subscriptionCounts().quotes, 1);
  const p = f.session.state.positions.ids()[0];
  const beforeA = a.overlays[0].updates.length, beforeB = b.overlays[0].updates.length;
  f.session.host.plUpdate(p, 25);
  assert.equal(a.overlays[0].updates.length, beforeA);
  assert.equal(b.overlays[0].updates.length, beforeB);
  f.session.host.positionUpdate({
    ...f.session.state.positions.get(p),
    extra: { pl: 10 },
  });
  assert.equal(a.overlays[0].updates.length, beforeA + 1);
  assert.equal(b.overlays[0].updates.length, beforeB + 1);
  f.remove(a.port);
  await flush();
  assert.equal(a.overlays[0].removed, true);
  assert.equal(f.simulation.controls.subscriptionCounts().quotes, 1);
  coordinator.destroy();
  coordinator.destroy();
  await flush();
  assert.equal(b.overlays[0].removed, true);
  assert.equal(f.simulation.controls.subscriptionCounts().quotes, 0);
  f.session.destroy();
});
test("X04/X05: binding generations remove prior overlays and drag commit/cancel own one semantic outcome", async () => {
  const f = fixture();
  await f.session.ready;
  f.session.host.orderUpdate({ id: 'move-order', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 99 });
  const chart = f.chart("A"),
    actions = [],
    errors = [];
  const coordinator = createOverlayCoordinator(
    f.session,
    f.collection,
    (action) => {
      actions.push(action);
      throw new Error("broker rejected");
    },
    (error) => errors.push(error),
  );
  const overlay = chart.overlays.find(value => value.spec.kind === 'order');
  overlay.fire({ type: "dragStart", gestureId: "g", price: 99 });
  overlay.fire({ type: "dragPreview", gestureId: "g", price: 101 });
  assert.equal(actions.length, 0);
  overlay.fire({ type: "dragCommit", gestureId: "g", price: 101 });
  overlay.fire({ type: "dragCommit", gestureId: "g", price: 101 });
  assert.equal(actions.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(overlay.updates.at(-1).price, 99);
  overlay.fire({ type: "dragStart", gestureId: "g2", price: 99 });
  overlay.fire({ type: "dragCancel", gestureId: "g2", price: 102 });
  assert.equal(actions.length, 1);
  chart.binding.set({ id: "A", generation: 2, symbol: "OTHER" });
  assert.equal(overlay.removed, true);
  overlay.fire({ type: "close" });
  assert.equal(actions.length, 1);
  coordinator.destroy();
  f.session.destroy();
});

test('X01: close-action and crosshair feature restrictions reach native overlay specs', async () => {
  const f = fixture({ enabledFeatures: ['chart_hide_close_position_button', 'chart_hide_close_order_button'], disabledFeatures: ['chart_crosshair_menu'] });
  await f.session.ready;
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
  try {
    assert(!chart.overlays[0].spec.actions.includes('close'));
    f.session.host.orderUpdate({ id: 'feature-order', symbol: 'SIM:X', side: 1, type: 1, qty: 1, status: 6, limitPrice: 10 });
    assert(!chart.overlays.find(overlay => overlay.spec.entityId === 'feature-order').spec.actions.includes('cancel'));
    assert.deepEqual(await chart.port.contextActions(chart.binding.get(), 10), []);
  } finally { coordinator.destroy(); f.session.destroy(); }
});

test('P01/P02/X03: chart money estimates format broker units, ignore table money and share active-symbol demand', async () => {
  const f = fixture({ configureBroker(broker) { const info = broker.symbolInfo; broker.symbolInfo = () => info('SIM:X'); }, brokerConfig: { configFlags: { supportPLUpdate: false } }, formatters: { numeric: async () => ({ format: value => value.toFixed(2) }) } });
  await f.session.ready;
  const a = f.chart('A'), b = f.chart('B');
  const errors = [], coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, error => errors.push(error));
  await flush(); await flush();
  const label = chart => chart.overlays[0].updates.at(-1)?.label ?? chart.overlays[0].spec.label;
  assert.equal(label(a), 'Long 4 · 3.96'); assert.equal(label(b), label(a));
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  const before = a.overlays[0].updates.length, id = f.session.state.positions.ids()[0];
  f.session.host.plUpdate(id, 9999);
  f.session.host.positionUpdate({ ...f.session.state.positions.get(id), extra: { pl: 777 } });
  assert.equal(a.overlays[0].updates.length, before);
  f.simulation.controls.quote('SIM:X', 102); await flush();
  assert.equal(label(a), 'Long 4 · 11.96'); assert.equal(label(b), label(a));
  f.simulation.controls.quoteError('SIM:X'); await flush(); assert.equal(label(a), 'Long 4');
  f.session.host.positionUpdate({ id: 'other', symbol: 'OTHER', qty: 2, side: 1, avgPrice: 100 });
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  a.binding.set({ id: 'A', generation: 2, symbol: 'OTHER' }); await flush(); await flush();
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 2);
  f.remove(b.port); assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  f.remove(a.port); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  coordinator.destroy(); f.session.destroy(); assert.deepEqual(errors, []);
});

test('P01/X09: chart quote updates among10000 positions touch only the100 displayed positions and no ID lists', async () => {
  const f = fixture({ configureBroker(broker) { const info = broker.symbolInfo; broker.symbolInfo = () => info('SIM:X'); }, brokerConfig: { configFlags: { supportPLUpdate: false } } }); await f.session.ready;
  for (let i = 0; i < 10000; i++) f.session.host.positionUpdate({ id: String(i), symbol: `S${i % 100}`, side: 1, qty: 2, avgPrice: 100 });
  const chart = f.chart('A'); chart.binding.set({ id: 'A', generation: 2, symbol: 'S0' });
  let gets = 0, ids = 0;
  const positions = f.session.state.positions;
  const session = { ...f.session, state: { ...f.session.state, positions: { ...positions, get(id) { gets++; return positions.get(id); }, ids() { ids++; return positions.ids(); } } } };
  const coordinator = createOverlayCoordinator(session, f.collection, () => {}); await flush(); await flush();
  f.simulation.controls.quote('S0', 102); await flush();
  gets = 0; ids = 0; const before = chart.overlays.map(overlay => overlay.updates.length);
  f.simulation.controls.quote('S0', 103); await flush();
  // Projection reuses its entity input; profit ownership performs the other visible-row lookup.
  assert.equal(ids, 0); assert.equal(gets, 200);
  assert.equal(chart.overlays.length, 100);
  assert(chart.overlays.every((overlay, index) => overlay.updates.length === before[index] + 1));
  assert(chart.overlays.every(overlay => overlay.updates.at(-1).price === undefined));
  assert(chart.overlays.every(overlay => typeof overlay.updates.at(-1).label === 'string'));
  coordinator.destroy(); f.session.destroy();
});

test('P01/A03: chart estimate formatting ignores old-account reads without reporting routine cancellation as a broker error', async () => {
  const { deferred } = await import('./manual-clock.mjs');
  const old = deferred(); let pending = true;
  const f = fixture({ brokerConfig: { configFlags: { supportPLUpdate: false } }, formatters: { numeric: () => pending ? old.promise : Promise.resolve({ format: value => `B:${value.toFixed(2)}` }) } });
  await f.session.ready;
  const chart = f.chart('A'), errors = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, error => errors.push(error));
  await flush(); pending = false; await f.session.commands.selectAccount('simulation-B'); await flush(); await flush();
  const overlay = chart.overlays.find(value => value.spec.entityId === 'simulation-B:net:SIM:X');
  assert.equal(overlay.updates.at(-1)?.label ?? overlay.spec.label, 'Long 4 · B:3.96');
  old.resolve({ format: () => 'OLD' }); await flush();
  assert.equal(overlay.updates.at(-1)?.label ?? overlay.spec.label, 'Long 4 · B:3.96');
  assert.deepEqual(errors, []); coordinator.destroy(); f.session.destroy();
});

test('P01/P02: netting charts estimate individual money from opening price and ignore individual table-only PL', async () => {
  const f = fixture({ profile: 'fx-netting', brokerConfig: { configFlags: { supportPLUpdate: false, supportPositions: true, supportPositionNetting: true, supportPositionBrackets: false, supportIndividualPositionBrackets: true } }, formatters: { numeric: async () => ({ format: value => value.toFixed(2) }) } });
  await f.session.ready; const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
  const id = 'simulation-A:individual:1', overlay = chart.overlays.find(value => value.spec.entityId === id);
  const label = () => overlay.updates.at(-1)?.label ?? overlay.spec.label;
  assert.equal(label(), 'Long 4 · 3.96');
  assert.equal(chart.overlays.filter(value => !value.removed).length, 1);
  const before = overlay.updates.length;
  f.session.host.individualPositionPLUpdate(id, 99999); assert.equal(overlay.updates.length, before);
  f.simulation.controls.quote('SIM:X', 101); await flush(); assert.equal(label(), 'Long 4 · 7.96');
  coordinator.destroy(); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0); f.session.destroy();
});

test('P01/U08: broker chart money uses numeric formatting and still ignores table-only monetary values', async () => {
  const f = fixture({ formatters: { numeric: async () => ({ format: value => `${value.toFixed(2)} units` }) } });
  await f.session.ready; const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
  const overlay = chart.overlays[0], label = () => overlay.updates.at(-1)?.label ?? overlay.spec.label;
  assert.equal(label(), 'Long 4 · 4.00 units');
  const id = f.session.state.positions.ids()[0], before = overlay.updates.length;
  f.session.host.plUpdate(id, 55); assert.equal(overlay.updates.length, before);
  f.session.host.positionUpdate({ ...f.session.state.positions.get(id), extra: { pl: 12.25 } });
  assert.equal(label(), 'Long 4 · 12.25 units');
  coordinator.destroy(); f.session.destroy();
});

test('P02/P03: chart display switches units without mutating broker money or acquiring pip demand for ticks/percentage', async () => {
  const f = fixture({ formatters: { numeric: async digits => ({ format: value => value.toFixed(digits) }) } });
  await f.session.ready; const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
  const overlay = chart.overlays[0], label = () => overlay.updates.at(-1)?.label ?? overlay.spec.label;
  assert.equal(label(), 'Long 4 · 4.00');
  f.session.updateDisplaySettings({ positionProfitDisplay: 'ticks' }); await flush(); await flush();
  assert.equal(label(), 'Long 4 · 99 ticks'); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  const id = f.session.state.positions.ids()[0];
  f.session.host.plUpdate(id, 99999);
  f.session.host.positionUpdate({ ...f.session.state.positions.get(id), extra: { pl: 800 } });
  assert.equal(label(), 'Long 4 · 99 ticks');
  f.session.updateDisplaySettings({ positionProfitDisplay: 'percentage' }); await flush(); await flush();
  assert.equal(label(), 'Long 4 · 1.00%'); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  f.session.host.positionUpdate({ ...f.session.state.positions.get(id), avgPrice: 0 });
  assert.equal(label(), 'Long 4');
  f.session.updateDisplaySettings({ showPositionProfit: false }); assert.equal(label(), 'Long 4');
  f.session.updateDisplaySettings({ showPositionProfit: true, positionProfitDisplay: 'money' }); await flush(); await flush();
  assert.equal(label(), 'Long 4 · 800.00');
  assert.equal(f.session.state.positions.get(id).extra.pl, 800);
  assert.equal(f.simulation.controls.calls().filter(call => ['placeOrder', 'modifyOrder', 'closePosition'].includes(call.method)).length, 0);
  coordinator.destroy(); f.session.destroy();
});

test('P02/P03: fractional forex pips retain instrument precision and hiding estimated chart money releases its feed', async () => {
  const f = fixture({ profile: 'fx-netting', brokerConfig: { configFlags: { supportPLUpdate: false, supportPositionNetting: true, supportIndividualPositionBrackets: true, supportPositionBrackets: false } }, formatters: { numeric: async digits => ({ format: value => value.toFixed(digits) }) } });
  await f.session.ready; const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
  const overlay = chart.overlays.find(value => value.spec.entityId === 'simulation-A:individual:1');
  const label = () => overlay.updates.at(-1)?.label ?? overlay.spec.label;
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  f.session.updateDisplaySettings({ positionProfitDisplay: 'ticks' }); await flush(); await flush();
  assert.equal(label(), 'Long 4 · 9.9 pips'); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  f.session.updateDisplaySettings({ positionProfitDisplay: 'money' }); await flush(); await flush();
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  f.session.updateDisplaySettings({ showPositionProfit: false });
  assert.equal(label(), 'Long 4'); assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  coordinator.destroy(); f.session.destroy();
});


const linkedOrder = (id, parentId, parentType) => ({ id, symbol: 'SIM:X', side: Side.Sell, type: OrderType.Limit, qty: 2, limitPrice: 110, status: OrderStatus.Working, parentId, parentType });
const linkedPosition = id => ({ id, symbol: 'SIM:X', side: Side.Buy, qty: 2, avgPrice: 100 });
test('B06: orphan bracket overlays await their typed parent and parent changes cancel captured gestures', async () => {
  for (const [parentType, kind] of [[ParentType.Order, 'order'], [ParentType.Position, 'position'], [ParentType.IndividualPosition, 'individualPosition']]) {
    const f = fixture({ profile: kind === 'individualPosition' ? 'fx-netting' : 'equity-net' }); let coordinator;
    try {
      await f.session.ready; const chart = f.chart('linked'), actions = [];
      coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action));
      const child = linkedOrder(`child-${kind}`, `parent-${kind}`, parentType);
      f.session.host.orderUpdate(child); assert.equal(chart.overlays.some(overlay => overlay.spec.entityId === child.id), false);
      let parent, publish;
      if (kind === 'order') { parent = { ...linkedPosition(child.parentId), type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 100 }; publish = f.session.host.orderUpdate; }
      else if (kind === 'position') { parent = linkedPosition(child.parentId); publish = f.session.host.positionUpdate; }
      else { parent = { id: child.parentId, symbol: 'SIM:X', side: Side.Buy, qty: 2, price: 100, date: 1700000000000 }; publish = f.session.host.individualPositionUpdate; }
      publish(parent); const overlay = chart.overlays.find(value => value.spec.entityId === child.id && !value.removed); assert(overlay); assert.equal(overlay.spec.group, `${kind}:${parent.id}`);
      overlay.fire({ type: 'dragStart', gestureId: 'captured-parent', price: 110 });
      publish({ ...parent, qty: 3 }); assert.equal(overlay.cancels, 1); assert.equal(overlay.updates.at(-1).price, 110);
      overlay.fire({ type: 'dragCommit', gestureId: 'captured-parent', price: 111 }); assert.equal(actions.length, 0);
      if (kind === 'order') publish({ ...parent, status: OrderStatus.Canceled }); else publish({ ...parent, qty: 0 });
      assert.equal(overlay.removed, true); overlay.fire({ type: 'modify' }); assert.equal(actions.length, 0);
    } finally { coordinator?.destroy(); f.session.destroy(); }
  }
});

test('B04/U01: a protection child is not draggable when its owner kind cannot edit brackets', async () => {
  const f = fixture({ profile: 'fx-netting' }); let coordinator;
  try {
    await f.session.ready; const chart = f.chart('unsupported-owner'), actions = [];
    coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action));
    f.session.host.positionUpdate(linkedPosition('net-parent'));
    f.session.host.orderUpdate(linkedOrder('net-child', 'net-parent', ParentType.Position));
    const overlay = chart.overlays.find(value => value.spec.entityId === 'net-child' && !value.removed); assert(overlay);
    assert.equal(overlay.spec.actions.includes('modify'), false);
    assert.equal(overlay.spec.actions.includes('cancel'), true);
    overlay.fire({ type: 'dragStart', gestureId: 'blocked', price: 111 }); overlay.fire({ type: 'dragCommit', gestureId: 'blocked', price: 111 });
    assert.equal(actions.length, 0);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('B01/B06: parent fill and typed reparenting replace the old scoped bracket overlay without a semantic dispatch', async () => {
  const f = fixture(); let coordinator;
  try {
    await f.session.ready; const chart = f.chart('reparent'), actions = [];
    const parent = { ...linkedPosition('parent-order'), type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 100 }, child = linkedOrder('transition-child', parent.id, ParentType.Order);
    f.session.host.orderUpdate(parent); f.session.host.orderUpdate(child);
    coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action));
    const before = chart.overlays.find(value => value.spec.entityId === child.id); before.fire({ type: 'dragStart', gestureId: 'before-fill', price: 110 });
    f.session.host.orderUpdate({ ...parent, status: OrderStatus.Filled }); assert.equal(before.removed, true);
    f.session.host.positionUpdate(linkedPosition('new-position'));
    assert.equal(chart.overlays.filter(value => value.spec.entityId === child.id && !value.removed).length, 0);
    f.session.host.orderUpdate({ ...child, parentId: 'new-position', parentType: ParentType.Position });
    const after = chart.overlays.find(value => value.spec.entityId === child.id && !value.removed); assert(after); assert.notEqual(after, before); assert.equal(after.spec.group, 'position:new-position');
    before.fire({ type: 'dragCommit', gestureId: 'before-fill', price: 111 }); assert.equal(actions.length, 0);
    const liveParent = { ...parent, id: 'still-working-parent' }, liveChild = { ...child, id: 'live-transition', parentId: liveParent.id };
    f.session.host.orderUpdate(liveParent); f.session.host.orderUpdate(liveChild);
    const liveBefore = chart.overlays.find(value => value.spec.entityId === liveChild.id && !value.removed); liveBefore.fire({ type: 'dragStart', gestureId: 'live-reparent', price: 110 });
    f.session.host.orderUpdate({ ...liveChild, parentId: 'new-position', parentType: ParentType.Position });
    const liveAfter = chart.overlays.find(value => value.spec.entityId === liveChild.id && !value.removed);
    assert.equal(liveBefore.removed, true); assert.equal(liveBefore.cancels, 1); assert.notEqual(liveAfter, liveBefore); assert.equal(liveAfter.spec.group, 'position:new-position');
    liveBefore.fire({ type: 'dragCommit', gestureId: 'live-reparent', price: 111 }); assert.equal(actions.length, 0);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('B06: parent IDs are scoped by entity type while an order cannot be its own bracket parent', async () => {
  const f = fixture(); let coordinator;
  try {
    await f.session.ready; const chart = f.chart('typed-ids');
    f.session.host.orderUpdate(linkedOrder('same-id', 'same-id', ParentType.Position));
    f.session.host.positionUpdate(linkedPosition('same-id'));
    f.session.host.orderUpdate(linkedOrder('invalid-self', 'invalid-self', ParentType.Order));
    coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
    assert(chart.overlays.some(value => value.spec.entityId === 'same-id' && value.spec.kind === 'bracket'));
    assert.equal(chart.overlays.some(value => value.spec.entityId === 'invalid-self'), false);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('B06/X09: removing one parent among10000 unrelated orders touches its indexed child without scanning order IDs', async () => {
  const f = fixture(); let coordinator;
  try {
    await f.session.ready;
    for (let index = 0; index < 10000; index++) f.session.host.orderUpdate({ id: `unrelated-${index}`, symbol: 'OTHER', side: Side.Buy, type: OrderType.Limit, status: OrderStatus.Working, qty: 1, limitPrice: 100 });
    const parent = linkedPosition('bounded-parent'), child = linkedOrder('bounded-child', parent.id, ParentType.Position);
    f.session.host.positionUpdate(parent); f.session.host.orderUpdate(child); const chart = f.chart('bounded');
    const orders = f.session.state.orders; let scans = 0, reads = 0;
    const observed = { ...f.session, state: { ...f.session.state, orders: { ...orders, ids: () => { scans++; return orders.ids(); }, get: id => { reads++; return orders.get(id); } } } };
    coordinator = createOverlayCoordinator(observed, f.collection, () => {}); const overlay = chart.overlays.find(value => value.spec.entityId === child.id); assert(overlay); scans = 0; reads = 0;
    f.session.host.positionUpdate({ ...parent, qty: 0 }); assert.equal(overlay.removed, true); assert.equal(scans, 0); assert.equal(reads, 1);
    f.session.host.orderUpdate({ ...child, status: OrderStatus.Canceled }); scans = 0; reads = 0;
    f.session.host.positionUpdate(parent); assert.equal(scans, 0); assert.equal(reads, 0, 'terminal children leave the dependency index');
  } finally { coordinator?.destroy(); f.session.destroy(); }
});


test('B06/U01: current overlay actions fence unsupported events and cancel a gesture when editing permission disappears', async () => {
  const f = fixture(); let coordinator;
  try {
    await f.session.ready;
    f.session.host.orderUpdate({ ...linkedPosition('permission-order'), type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 99 });
    const chart = f.chart('permissions'), actions = [];
    coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action));
    const overlay = chart.overlays.find(value => value.spec.kind === 'order'); assert(overlay);
    overlay.fire({ type: 'close' }); overlay.fire({ type: 'reverse' }); overlay.fire({ type: 'protect' }); assert.equal(actions.length, 0);
    overlay.fire({ type: 'dragStart', gestureId: 'before-permission-loss', price: 99 });
    f.session.host.patchConfig({ supportModifyOrderPrice: false, supportEditAmount: false, supportModifyBrackets: false });
    assert.equal(overlay.cancels, 1); overlay.fire({ type: 'dragCommit', gestureId: 'before-permission-loss', price: 100 }); overlay.fire({ type: 'modify' }); assert.equal(actions.length, 0);
    overlay.fire({ type: 'cancel' }); assert.equal(actions.length, 1); assert.equal(actions[0].event.type, 'cancel');
    f.session.host.patchConfig({ supportModifyOrderPrice: true, supportEditAmount: true, supportModifyBrackets: true });
    overlay.fire({ type: 'dragStart', gestureId: 'before-disconnect', price: 99 }); f.simulation.controls.disconnect();
    assert.equal(overlay.cancels, 2); assert.deepEqual(overlay.updates.at(-1).actions, []);
    overlay.fire({ type: 'dragCommit', gestureId: 'before-disconnect', price: 100 }); overlay.fire({ type: 'cancel' }); overlay.fire({ type: 'modify' }); assert.equal(actions.length, 1);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});


test('X04/A04: outgoing overlay specifications and patches are immutable across a host boundary', async () => {
  const observed = { spec: false, actions: false, rejected: 0, patches: [] };
  const f = fixture({ inspectOverlay: spec => {
    if (spec.kind !== 'order') return;
    observed.spec = Object.isFrozen(spec); observed.actions = Object.isFrozen(spec.actions);
    try { spec.actions.push('close'); } catch { observed.rejected++; }
    try { spec.group = 'host-mutated'; } catch { observed.rejected++; }
  }, inspectPatch: (spec, patch) => {
    if (spec.kind !== 'order') return;
    const frozen = Object.isFrozen(patch); let rejected = false;
    try { patch.price = 999; } catch { rejected = true; }
    observed.patches.push({ frozen, rejected, price: patch.price });
  } }); let coordinator;
  try {
    await f.session.ready; const order = { ...linkedPosition('immutable-order'), type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 99 };
    f.session.host.orderUpdate(order); const chart = f.chart('immutable'), actions = [];
    coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action));
    assert.equal(observed.spec, true); assert.equal(observed.actions, true); assert.equal(observed.rejected, 2);
    const overlay = chart.overlays.find(value => value.spec.entityId === order.id); overlay.fire({ type: 'close' }); assert.equal(actions.length, 0);
    f.session.host.orderUpdate({ ...order, limitPrice: 100 }); assert(observed.patches.some(patch => patch.price === 100)); assert(observed.patches.every(patch => patch.frozen && patch.rejected));
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('X04/A04: pending semantic actions retain copied event prices and malformed callbacks never dispatch', async () => {
  const f = fixture(); let coordinator, finish, starts = 0; const actions = [], errors = [];
  try {
    await f.session.ready; f.session.host.orderUpdate({ ...linkedPosition('event-order'), type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 99 }); const chart = f.chart('events');
    coordinator = createOverlayCoordinator(f.session, f.collection, async action => { starts++; await new Promise(resolve => { finish = resolve; }); actions.push(action); }, error => errors.push(error));
    const overlay = chart.overlays.find(value => value.spec.entityId === 'event-order');
    overlay.fire({ type: 'dragStart', gestureId: 'reviewed', price: 99 });
    const event = { type: 'dragCommit', gestureId: 'reviewed', price: 100 }; overlay.fire(event); event.price = 999; finish(); await flush();
    assert.equal(actions.length, 1); assert.equal(actions[0].event.price, 100); assert(Object.isFrozen(actions[0].event));
    let accessed = 0; overlay.fire({ get type() { accessed++; return 'cancel'; } });
    overlay.fire({ type: 'unknown' }); overlay.fire({ type: 'dragCommit', gestureId: 'invalid', price: Infinity });
    assert.equal(accessed, 0); assert.equal(errors.length, 3); assert.equal(actions.length, 1);
    overlay.fire({ type: 'dragStart', gestureId: 'broken-stream', price: 99 }); overlay.fire({ type: 'dragPreview', gestureId: 'broken-stream', price: Infinity });
    assert.equal(overlay.cancels, 1); assert.equal(overlay.updates.at(-1).price, 99); assert.equal(errors.length, 4);
    overlay.fire({ type: 'dragCommit', gestureId: 'broken-stream', price: 101 }); assert.equal(starts, 1, 'a malformed callback cancels ownership before a later commit');
  } finally { finish?.(); coordinator?.destroy(); f.session.destroy(); }
});

test('X01/U04: chart context items name a tick-formatted price and the order type relative to the market', async () => {
  const f = fixture(); let coordinator;
  try {
    await f.session.ready; const chart = f.chart('context');
    coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
    f.simulation.controls.quote('SIM:X', 100); await flush();
    const below = await chart.port.contextActions(chart.binding.get(), 98.123456), above = await chart.port.contextActions(chart.binding.get(), 101.987);
    assert.deepEqual(below.slice(0, 2).map((item) => item.text), ['Buy @ 98.12 Limit', 'Sell @ 98.12 Stop']);
    assert.deepEqual(above.slice(0, 2).map((item) => item.text), ['Buy @ 101.99 Stop', 'Sell @ 101.99 Limit']);
    assert.deepEqual(above[0].intent, { type: 'openTicket', binding: chart.binding.get(), side: Side.Buy, price: 101.99, orderType: OrderType.Stop });
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('U10/X01: adaptive trading lines drop the TP/SL button and P&L on narrow screens unless the broker disables adaptivity', async () => {
  for (const adaptive of [true, false]) {
    const f = fixture({ brokerConfig: { ...createDeterministicBroker().brokerConfig, tradedGroupConfig: { supportAdaptiveLayout: adaptive } }, formatters: { numeric: async () => ({ format: (value) => value.toFixed(2) }) } });
    let coordinator;
    try {
      await f.session.ready; const chart = f.chart('adaptive'); const narrow = new ValueStore(true);
      coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, undefined, narrow); await flush(); await flush();
      const overlay = chart.overlays.find((value) => value.spec.kind === 'position');
      const spec = () => ({ ...overlay.spec, ...Object.fromEntries(overlay.updates.flatMap((update) => Object.entries(update)).filter(([, value]) => value !== undefined)) });
      if (adaptive) {
        assert.equal(spec().label, 'Long 4'); assert.equal(spec().actions.includes('protect'), false);
        narrow.set(false); await flush();
        assert.match(spec().label, /^Long 4 · /); assert.equal(spec().actions.includes('protect'), true);
      } else {
        assert.match(spec().label, /^Long 4 · /); assert.equal(spec().actions.includes('protect'), true);
      }
    } finally { coordinator?.destroy(); f.session.destroy(); }
  }
});
test("X03/U09: tradedSourcesVisibility false removes every order, position and execution overlay and true restores them", async () => {
  const f = fixture();
  await f.session.ready;
  const a = f.chart("A");
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
  await flush();
  const live = () => a.overlays.filter((overlay) => !overlay.removed).length;
  const before = live();
  assert(before > 0);
  f.session.host.tradedSourcesVisibility().setValue(false);
  await flush();
  assert.equal(live(), 0);
  f.session.host.positionUpdate({ ...f.session.state.positions.get(f.session.state.positions.ids()[0]) });
  await flush();
  assert.equal(live(), 0, "updates while hidden create no overlays");
  f.session.host.tradedSourcesVisibility().setValue(true);
  await flush();
  assert.equal(live(), before);
  coordinator.destroy();
  f.session.destroy();
});

test('U05/X01: chartContextMenuActions decides the chart items: host defaults keep the chart intent, broker items run their callbacks, and an empty list removes trading items', async () => {
  let reply = 'default', ran = 0, context;
  const f = fixture({ configureBroker(broker) {
    const original = broker.chartContextMenuActions.bind(broker);
    broker.chartContextMenuActions = async (value, options) => {
      context = value;
      if (reply === 'empty') return [];
      if (reply === 'custom') return [{ text: 'Alert at price', action: () => ran++ }, { separator: true }, { text: 'Disabled', enabled: false, action: () => ran++ }];
      if (reply === 'fail') throw new Error('broker down');
      return original(value, options);
    };
  } });
  let coordinator; const errors = [];
  try {
    await f.session.ready; const chart = f.chart('broker-menu');
    coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, (error) => errors.push(error)); await flush(); await flush();
    f.simulation.controls.quote('SIM:X', 100); await flush();
    const defaults = await chart.port.contextActions(chart.binding.get(), 98.123456);
    assert.deepEqual(defaults.map((item) => item.text), ['Buy @ 98.12 Limit', 'Sell @ 98.12 Stop', 'Trading settings']);
    assert.deepEqual(defaults[0].intent, { type: 'openTicket', binding: chart.binding.get(), side: Side.Buy, price: 98.12, orderType: OrderType.Limit });
    assert.equal(typeof defaults[2].run, 'function');
    assert.deepEqual({ symbol: context.symbol, value: context.value, formattedValue: context.formattedValue, last: context.last }, { symbol: 'SIM:X', value: 98.12, formattedValue: '98.12', last: 100 });
    reply = 'custom';
    const custom = await chart.port.contextActions(chart.binding.get(), 99);
    assert.deepEqual(custom.map((item) => item.text ?? '-'), ['Alert at price', '-', 'Disabled']);
    assert.equal(custom[2].enabled, false);
    custom[0].run(); assert.equal(ran, 1);
    reply = 'empty';
    assert.deepEqual(await chart.port.contextActions(chart.binding.get(), 99), []);
    reply = 'fail';
    assert.deepEqual((await chart.port.contextActions(chart.binding.get(), 99)).map((item) => item.text), ['Buy @ 99.00 Limit', 'Sell @ 99.00 Stop']);
    assert.equal(errors.length, 1);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('P01/U01: positionPLInInstrumentCurrency labels chart money in the instrument currency and estimates without pip-value conversion', async () => {
  const labels = {};
  for (const inInstrument of [false, true]) {
    const base = createDeterministicBroker().brokerConfig;
    const f = fixture({ brokerConfig: { ...base, configFlags: { ...base.configFlags, supportPLUpdate: false, positionPLInInstrumentCurrency: inInstrument } }, formatters: { numeric: async () => ({ format: (value) => value.toFixed(2) }) } });
    let coordinator;
    try {
      await f.session.ready; const chart = f.chart(`currency-${inInstrument}`);
      coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
      f.simulation.controls.quote('SIM:X', 101); for (let i = 0; i < 6; i++) await flush();
      const overlay = chart.overlays.find((value) => value.spec.kind === 'position');
      labels[inInstrument] = [overlay.spec, ...overlay.updates].map((value) => value.label).filter(Boolean).at(-1);
    } finally { coordinator?.destroy(); f.session.destroy(); }
  }
  assert.match(labels.true, /^Long \d+ · [+-]?[\d.,]+ USD$/, labels.true);
  assert.doesNotMatch(labels.false, /USD/, labels.false);
});

test('U05/X01: chartContextMenuActions that never answers falls back to the platform Buy/Sell items after one second, and malformed entries are skipped', async () => {
  let mode = 'hang';
  const clock = new ManualClock();
  const f = fixture({ clock, configureBroker(broker) {
    broker.chartContextMenuActions = async () => (mode === 'hang' ? new Promise(() => {}) : [null, 'text', { text: 'No action' }, { text: 'Ok', action() {} }]);
  } });
  let coordinator;
  try {
    await f.session.ready; const chart = f.chart('slow-menu');
    coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush(); await flush();
    f.simulation.controls.quote('SIM:X', 100); await flush();
    let settled = false;
    const pending = chart.port.contextActions(chart.binding.get(), 99).then(items => { settled = true; return items; });
    for (let i = 0; i < 6; i++) await flush();
    clock.advance(999); await flush();
    assert.equal(settled, false);
    clock.advance(1);
    const items = await pending;
    assert.deepEqual(items.map((item) => item.text), ['Buy @ 99.00 Limit', 'Sell @ 99.00 Stop']);
    mode = 'malformed';
    assert.deepEqual((await chart.port.contextActions(chart.binding.get(), 99)).map((item) => item.text), ['Ok']);
  } finally { coordinator?.destroy(); f.session.destroy(); }
});

test('OC06/OC08: reviewed group stays muted after ticket handoff and restores confirmed siblings on discard', async () => {
  const f = fixture(); await f.session.ready;
  const parent = { id: 'review-parent', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98.5 };
  f.session.host.orderUpdate(parent);
  f.session.host.orderUpdate({ ...parent, id: 'review-tp', parentId: parent.id, parentType: ParentType.Order, side: Side.Sell, limitPrice: 101 });
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => { f.session.chartEdits.propose(action.event.price); });
  await flush();
  const root = chart.overlays.find(value => value.spec.entityId === parent.id);
  const child = chart.overlays.find(value => value.spec.entityId === 'review-tp');
  root.fire({ type: 'dragStart', gestureId: 'G', leg: 'stopLoss', price: 98.5 });
  root.fire({ type: 'dragPreview', gestureId: 'G', leg: 'stopLoss', price: 97 });
  root.fire({ type: 'dragCommit', gestureId: 'G', leg: 'stopLoss', price: 97 });
  await flush();
  assert.equal(root.updates.at(-1).protection.phase, 'pending');
  assert.equal(root.updates.at(-1).protection.preview.price, 97);
  assert.equal(child.updates.at(-1).protection.muted, true);
  assert.equal(child.updates.at(-1).protection.phase, 'confirmed');
  assert.equal(child.updates.at(-1).protection.showRegion, false);
  f.session.chartEdits.clear();
  assert.equal(root.updates.at(-1).protection.preview, undefined);
  assert.equal(child.updates.at(-1).protection.phase, 'confirmed');
  assert.equal(child.updates.at(-1).protection.muted, undefined);
  assert.equal(f.simulation.controls.calls().filter(call => call.method === 'modifyOrder').length, 0);
  coordinator.destroy(); f.session.destroy();
});

test('OC08: dragging a confirmed position exit reviews the position protection and keeps the line at the dragged price while inputs change', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('drag-parent');
  f.session.host.positionUpdate(position);
  f.session.host.orderUpdate({ ...linkedOrder('drag-tp', position.id, ParentType.Position), limitPrice: 105 });
  f.session.host.orderUpdate({ ...linkedOrder('drag-sl', position.id, ParentType.Position), type: OrderType.Stop, limitPrice: undefined, stopPrice: 95 });
  const chart = f.chart('A'), actions = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => {
    actions.push(action);
    f.session.chartEdits.propose(action.event.price);
  });
  await flush();
  const stop = chart.overlays.find(value => value.spec.entityId === 'drag-sl' && !value.removed);
  assert(stop.spec.actions.includes('modify'));
  stop.fire({ type: 'dragStart', gestureId: 'S', price: 95 });
  const edit = f.session.chartEdits.state.get();
  assert.equal(edit.kind, 'position'); assert.equal(edit.id, position.id); assert.equal(edit.leg, 'stopLoss');
  assert.equal(edit.order.takeProfit, 105, 'the review starts from both confirmed legs');
  stop.fire({ type: 'dragPreview', gestureId: 'S', price: 93 });
  assert.equal(stop.updates.at(-1).protection.preview.price, 93);
  stop.fire({ type: 'dragCommit', gestureId: 'S', price: 93 });
  await flush();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'position'); assert.equal(actions[0].entityId, position.id);
  assert.equal(actions[0].event.leg, 'stopLoss'); assert.equal(actions[0].revision, edit.context.revision);
  const reviewed = stop.updates.at(-1).protection;
  assert.equal(reviewed.phase, 'pending'); assert.equal(reviewed.preview.price, 93);
  const tp = chart.overlays.find(value => value.spec.entityId === 'drag-tp' && !value.removed);
  const updates = [stop.updates.length, tp.updates.length];
  f.session.chartEdits.syncPosition({ takeProfit: 108, stopLoss: 92 });
  assert.deepEqual([stop.updates.length, tp.updates.length], updates, 'input edits leave the lines where the drag left them');
  const lastActions = overlay => overlay.updates.filter(update => update.actions).at(-1)?.actions ?? overlay.spec.actions;
  assert.equal(lastActions(tp).includes('modify'), false, 'the other exit cannot be dragged during the review');
  assert.equal(lastActions(stop).includes('modify'), false, 'the reviewed exit cannot be dragged again');
  const position_ = chart.overlays.find(value => value.spec.entityId === position.id && !value.removed);
  const reviewToken = f.session.chartEdits.state.get().token, cancels = tp.cancels;
  tp.fire({ type: 'dragStart', gestureId: 'X', price: 105 });
  assert.equal(tp.cancels, cancels + 1); assert.equal(f.session.chartEdits.state.get().token, reviewToken, 'the review keeps its proposal');
  const stopCancels = stop.cancels;
  stop.fire({ type: 'dragStart', gestureId: 'retry', price: 93 });
  stop.fire({ type: 'dragPreview', gestureId: 'retry', price: 91 });
  stop.fire({ type: 'dragCommit', gestureId: 'retry', price: 91 });
  assert.equal(stop.cancels, stopCancels + 1);
  assert.equal(actions.length, 1);
  assert.equal(f.session.chartEdits.state.get().token, reviewToken);
  assert.equal(stop.updates.at(-1).protection.preview.price, 93);
  assert.deepEqual(position_.updates.at(-1).protection.handles, [], 'no new TP/SL handles during the review');
  f.session.chartEdits.clear();
  assert.equal(lastActions(tp).includes('modify'), true, 'the lock ends with the review');
  assert.equal(stop.updates.at(-1).protection.preview.price, 95, 'discard restores the confirmed stop');
  assert.equal(f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets').length, 0);
  coordinator.destroy(); f.session.destroy();
});

test('OC08: releasing a new TP locks both legs even before review preparation finishes', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('review-legs');
  f.session.host.positionUpdate(position);
  const chart = f.chart('A');
  let finishPreparation;
  const preparing = new Promise(resolve => { finishPreparation = resolve; });
  const coordinator = createOverlayCoordinator(f.session, f.collection, async action => {
    await preparing;
    f.session.chartEdits.propose(action.event.price);
  });
  await flush();
  const line = chart.overlays.find(value => value.spec.entityId === position.id && !value.removed);
  assert.deepEqual(line.spec.protection.handles, ['takeProfit', 'stopLoss']);
  line.fire({ type: 'dragStart', gestureId: 'TP', leg: 'takeProfit', price: 100 });
  line.fire({ type: 'dragPreview', gestureId: 'TP', leg: 'takeProfit', price: 105 });
  line.fire({ type: 'dragCommit', gestureId: 'TP', leg: 'takeProfit', price: 105 });
  await flush();
  const review = line.updates.at(-1).protection;
  assert.equal(review.preview.leg, 'takeProfit');
  assert.equal(review.phase, 'pending');
  assert.deepEqual(review.handles, []);
  assert.deepEqual(review.lockedHandles, ['takeProfit', 'stopLoss']);
  const token = f.session.chartEdits.state.get().token, cancels = line.cancels;
  line.fire({ type: 'dragStart', gestureId: 'retry', leg: 'takeProfit', price: 105 });
  line.fire({ type: 'dragStart', gestureId: 'SL', leg: 'stopLoss', price: 100 });
  assert.equal(line.cancels, cancels + 2);
  assert.equal(f.session.chartEdits.state.get().token, token, 'the TP review keeps its proposal');
  const paintCount = line.updates.length;
  finishPreparation();
  await flush();
  assert.equal(line.updates.length, paintCount, 'opening the ticket keeps the existing chart lock without repainting');
  assert.equal(line.updates.at(-1).protection.preview.price, 105);
  assert.equal(f.session.chartEdits.state.get().order.takeProfit, 105);
  assert.deepEqual(line.updates.at(-1).protection.handles, []);
  f.session.chartEdits.clear();
  assert.deepEqual(line.updates.at(-1).protection.handles, ['takeProfit', 'stopLoss'], 'both handles return after the review');
  coordinator.destroy(); f.session.destroy();
});

test('OC08: a sibling exit arriving during protection review starts locked', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('late-sibling');
  f.session.host.positionUpdate(position);
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => {
    f.session.chartEdits.propose(action.event.price);
  });
  try {
    await flush();
    const line = chart.overlays.find(value => value.spec.entityId === position.id && !value.removed);
    line.fire({ type: 'dragStart', gestureId: 'TP', leg: 'takeProfit', price: 100 });
    line.fire({ type: 'dragCommit', gestureId: 'TP', leg: 'takeProfit', price: 105 });
    const stop = {
      ...linkedOrder('late-sibling-sl', position.id, ParentType.Position),
      type: OrderType.Stop, limitPrice: undefined, stopPrice: 95,
    };
    f.session.host.orderUpdate(stop); await flush();
    const sibling = chart.overlays.find(value => value.spec.entityId === stop.id && !value.removed);
    assert.equal(sibling.spec.protection.muted, true);
    assert.equal(sibling.spec.actions.includes('modify'), false);
    f.session.chartEdits.clear();
    assert.equal(sibling.updates.at(-1).actions.includes('modify'), true);
    assert.equal(sibling.updates.at(-1).protection.muted, undefined);
  } finally { coordinator.destroy(); f.session.destroy(); }
});

test('OC08: a rejected release cannot clear or repaint a newer protection gesture', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('review-race');
  f.session.host.positionUpdate(position);
  const chart = f.chart('A');
  let rejectRelease;
  const pending = new Promise((_resolve, reject) => { rejectRelease = reject; });
  const errors = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => pending, error => errors.push(error));
  try {
    await flush();
    const line = chart.overlays.find(value => value.spec.entityId === position.id && !value.removed);
    line.fire({ type: 'dragStart', gestureId: 'old', leg: 'takeProfit', price: 100 });
    line.fire({ type: 'dragCommit', gestureId: 'old', leg: 'takeProfit', price: 105 });
    f.session.chartEdits.clear();
    line.fire({ type: 'dragStart', gestureId: 'new', leg: 'stopLoss', price: 100 });
    line.fire({ type: 'dragPreview', gestureId: 'new', leg: 'stopLoss', price: 95 });
    const token = f.session.chartEdits.state.get().token;
    const paintCount = line.updates.length;
    rejectRelease(new Error('Preparation failed')); await flush();
    assert.equal(errors.length, 1);
    assert.equal(f.session.chartEdits.state.get().token, token);
    assert.equal(line.updates.length, paintCount);
    assert.equal(line.updates.at(-1).protection.preview.price, 95);
    line.fire({ type: 'dragCancel', gestureId: 'new' });
    assert.equal(f.session.chartEdits.state.get(), undefined);
  } finally { coordinator.destroy(); f.session.destroy(); }
});

test('B06: exits of a waiting market order draw as TP/SL pills measured from the price it would fill at', async () => {
  const f = fixture(); await f.session.ready;
  const releaseQuotes = f.session.acquireQuotes('SIM:X', 'fast', () => {}); await flush(); await flush();
  const ask = f.session.state.quotes.get('SIM:X')?.ask; assert(Number.isFinite(ask), 'the simulated quote arrived');
  const parent = { id: 'market-parent', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Market, status: OrderStatus.Working };
  f.session.host.orderUpdate(parent);
  f.session.host.orderUpdate({ ...linkedOrder('market-tp', parent.id, ParentType.Order), limitPrice: 102, status: OrderStatus.Inactive });
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
  await flush();
  const tp = chart.overlays.find(value => value.spec.entityId === 'market-tp' && !value.removed);
  assert.equal(tp.spec.protection?.entryPrice, ask, 'a buy measures from the ask');
  assert.equal(tp.spec.protection?.preview.leg, 'takeProfit');
  assert.equal(tp.spec.protection?.phase, 'inactive', 'a broker-accepted exit waiting on its parent stays dashed');
  releaseQuotes(); coordinator.destroy(); f.session.destroy();
});

test('B06: a position whose TP/SL arrive only as child orders offers no handle for those legs', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('child-legs');
  f.session.host.positionUpdate(position);
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
  await flush();
  const handles = () => {
    const overlay = chart.overlays.find(value => value.spec.entityId === position.id && !value.removed);
    return overlay.updates.filter(update => update.protection).at(-1)?.protection.handles ?? overlay.spec.protection.handles;
  };
  assert.deepEqual(handles(), ['takeProfit', 'stopLoss']);
  f.session.host.orderUpdate({ ...linkedOrder('child-tp', position.id, ParentType.Position), limitPrice: 105 });
  assert.deepEqual(handles(), ['stopLoss'], 'a child TP removes the TP handle');
  f.session.host.orderUpdate({ ...linkedOrder('child-sl', position.id, ParentType.Position), type: OrderType.Stop, limitPrice: undefined, stopPrice: 95 });
  assert.deepEqual(handles(), []);
  f.session.host.orderUpdate({ ...linkedOrder('child-tp', position.id, ParentType.Position), limitPrice: 105, status: OrderStatus.Canceled });
  assert.deepEqual(handles(), ['takeProfit'], 'a cancelled child brings its handle back');
  coordinator.destroy(); f.session.destroy();
});

test('OC08: a single confirmed pair tagged with a level ID still moves the parent pair', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('tagged-parent');
  f.session.host.positionUpdate({ ...position, takeProfit: 105, stopLoss: 95 });
  f.session.host.orderUpdate({ ...linkedOrder('tagged-tp', position.id, ParentType.Position), exitLevelId: 'pair', limitPrice: 105 });
  f.session.host.orderUpdate({ ...linkedOrder('tagged-sl', position.id, ParentType.Position), exitLevelId: 'pair', type: OrderType.Stop, limitPrice: undefined, stopPrice: 95 });
  const chart = f.chart('A'), errors = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => { f.session.chartEdits.propose(action.event.price); }, cause => errors.push(cause));
  await flush();
  const stop = chart.overlays.find(value => value.spec.entityId === 'tagged-sl' && !value.removed);
  stop.fire({ type: 'dragStart', gestureId: 'T', price: 95 });
  assert.equal(f.session.chartEdits.state.get().level, undefined, 'no allocated level to move');
  stop.fire({ type: 'dragCommit', gestureId: 'T', price: 96 });
  await flush();
  assert.deepEqual(errors, []);
  const edit = f.session.chartEdits.state.get();
  assert.equal(edit.order.stopLoss, 96); assert.equal(edit.order.takeProfit, 105); assert.equal(edit.order.exitLevels, undefined);
  coordinator.destroy(); f.session.destroy();
});

test('OC08: a parent edit cleared mid-drag restores the dragged exit line, and a cancel forgets the parent', async () => {
  const f = fixture(); await f.session.ready;
  const position = linkedPosition('clear-parent');
  f.session.host.positionUpdate(position);
  f.session.host.orderUpdate({ ...linkedOrder('clear-sl', position.id, ParentType.Position), type: OrderType.Stop, limitPrice: undefined, stopPrice: 95 });
  const chart = f.chart('A');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {});
  await flush();
  const stop = chart.overlays.find(value => value.spec.entityId === 'clear-sl' && !value.removed);
  stop.fire({ type: 'dragStart', gestureId: 'C', price: 95 });
  stop.fire({ type: 'dragPreview', gestureId: 'C', price: 93 });
  assert.equal(stop.updates.at(-1).protection.preview.price, 93);
  f.session.chartEdits.clear();
  assert.equal(stop.updates.at(-1).protection.preview.price, 95, 'the exit returns to its broker price');
  stop.fire({ type: 'dragStart', gestureId: 'D', price: 95 });
  stop.fire({ type: 'dragCancel', gestureId: 'D', price: 95 });
  assert.equal(f.session.chartEdits.state.get(), undefined);
  coordinator.destroy(); f.session.destroy();
});

test('OC08: dragging one allocated exit level moves only that level and previews its own quantity', async () => {
  const f = fixture(); await f.session.ready;
  const position = { ...linkedPosition('levels-parent'), qty: 4 };
  f.session.host.positionUpdate(position);
  const exit = (id, level, type, price) => ({
    ...linkedOrder(id, position.id, ParentType.Position), qty: 2, exitLevelId: level, type,
    limitPrice: type === OrderType.Limit ? price : undefined, stopPrice: type === OrderType.Stop ? price : undefined,
  });
  f.session.host.orderUpdate(exit('l1-tp', 'L1', OrderType.Limit, 105));
  f.session.host.orderUpdate(exit('l1-sl', 'L1', OrderType.Stop, 95));
  f.session.host.orderUpdate(exit('l2-tp', 'L2', OrderType.Limit, 110));
  f.session.host.orderUpdate(exit('l2-sl', 'L2', OrderType.Stop, 92));
  const chart = f.chart('A'), actions = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => {
    actions.push(action);
    f.session.chartEdits.propose(action.event.price);
  });
  await flush();
  const stop = chart.overlays.find(value => value.spec.entityId === 'l2-sl' && !value.removed);
  stop.fire({ type: 'dragStart', gestureId: 'L', price: 92 });
  const edit = f.session.chartEdits.state.get();
  assert.equal(edit.kind, 'position'); assert.equal(edit.level, 'L2'); assert.equal(edit.multiple, false);
  assert.deepEqual(edit.order.exitLevels.map(level => level.id), ['L1', 'L2']);
  stop.fire({ type: 'dragPreview', gestureId: 'L', price: 90 });
  assert.equal(stop.updates.at(-1).protection.preview.quantity, '2', 'the level closes its own allocation');
  stop.fire({ type: 'dragCommit', gestureId: 'L', price: 90 });
  await flush();
  assert.equal(actions[0].event.leg, 'stopLoss');
  const levels = f.session.chartEdits.state.get().order.exitLevels;
  assert.deepEqual(levels.map(level => [level.id, level.qty, level.takeProfit, level.stopLoss]), [['L1', 2, 105, 95], ['L2', 2, 110, 90]]);
  assert.equal(stop.updates.at(-1).protection.preview.price, 90);
  coordinator.destroy(); f.session.destroy();
});

test('OC08/OC12: confirmed exit money owns one symbol lease and pip updates touch only indexed exits', async () => {
  const f = fixture(); await f.session.ready;
  const parent = { id: 'money-parent', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98.5 };
  f.session.host.orderUpdate(parent);
  f.session.host.orderUpdate({ ...parent, id: 'money-tp', parentId: parent.id, parentType: ParentType.Order, side: Side.Sell, limitPrice: 101 });
  const a = f.chart('A'), b = f.chart('B');
  let forbidIds = false;
  const orders = { ...f.session.state.orders, ids() { if (forbidIds) assert.fail('pip update enumerated order IDs'); return f.session.state.orders.ids(); } };
  const counted = { ...f.session, state: { ...f.session.state, orders } };
  const coordinator = createOverlayCoordinator(counted, f.collection, () => {}); await flush();
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1);
  const root = a.overlays.find(value => value.spec.entityId === parent.id), before = root.updates.length;
  const child = a.overlays.find(value => value.spec.entityId === 'money-tp');
  forbidIds = true;
  f.session.host.pipValueUpdate('SIM:X', { buyPipValue: 2, sellPipValue: 3 });
  assert.equal(root.updates.length, before);
  assert.equal(child.updates.at(-1).protection.preview.text, '+1000.00 USD');
  forbidIds = false;
  f.session.updateDisplaySettings({ showPositionProfit: false }); await flush();
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 1, 'bracket money does not follow the position switch');
  f.session.updateDisplaySettings({ showBracketProfit: false }); await flush();
  assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  coordinator.destroy(); f.session.destroy();
});

test('position previews judge exits against the current price; profit and money still measure from entry', async () => {
  const { editPreviewProtection } = await loadModule('src/chart/edit-preview.ts');
  const instrument = { qty: { min: 1, max: 10, step: 1 } };
  const edit = { token: 1, id: 'P', kind: 'position', phase: 'dragging', multiple: false, order: { symbol: 'X', side: 1, qty: 2, avgPrice: 99 } };
  const text = (side, qty, entry, exit) => `${entry}:${exit}`;
  const preview = (leg, price, reference) => editPreviewProtection({ edit, protection: { handles: [leg] }, point: { leg, price }, instrument, reference, profitText: text }).preview;
  assert.equal(preview('stopLoss', 99.5, 101).invalid, false, 'a profit-locking stop past entry but below the bid is valid');
  assert.equal(preview('stopLoss', 101.5, 101).invalid, true);
  assert.equal(preview('takeProfit', 100, 101).invalid, true, 'a take profit below the current price is invalid');
  assert.equal(preview('stopLoss', 99.5, 101).text, '99:99.5', 'money still measures from entry');
  assert.equal(preview('stopLoss', 99.5, undefined).invalid, true, 'without a quote the entry is the reference');
});

test('OC04/OC05: edit preview is pure: leg price, quantity, validity and exit-line body drags', async () => {
  const { editPreviewProtection, proposedEditPoint } = await loadModule('src/chart/edit-preview.ts');
  const instrument = { qty: { min: 1, max: 10, step: 1 } };
  const edit = { token: 7, id: 'O', kind: 'order', phase: 'dragging', multiple: false, order: { symbol: 'X', side: 1, type: 1, qty: 3, limitPrice: 100 } };
  const text = (side, qty, entry, exit) => `${side}:${qty}:${entry}:${exit}`;
  const tp = editPreviewProtection({ edit, protection: { handles: ['takeProfit'] }, point: { leg: 'takeProfit', price: 110 }, instrument, profitText: text });
  assert.deepEqual(tp.preview, { leg: 'takeProfit', price: 110, text: '1:3:100:110', quantity: '3', invalid: false });
  assert.equal(tp.phase, 'dragging');
  const wrongSide = editPreviewProtection({ edit, protection: { handles: [] }, point: { leg: 'takeProfit', price: 90 }, instrument, profitText: text });
  assert.equal(wrongSide.preview.invalid, true);
  const body = editPreviewProtection({ edit: { ...edit, phase: 'reviewing' }, protection: { handles: [], movingLeg: 'stopLoss', entryPrice: 105 }, point: { price: 101 }, instrument, profitText: text });
  assert.equal(body.preview.text, '-1:3:105:101', 'exit-line body drags measure the opposite exposure from the parent entry');
  assert.equal(body.phase, 'pending');
  assert.equal(editPreviewProtection({ edit, protection: { handles: [] }, point: { price: 101 }, instrument, profitText: text }), undefined);
  const multiple = editPreviewProtection({ edit: { ...edit, multiple: true, order: { ...edit.order, takeProfit: 120 } }, protection: { handles: [] }, point: { leg: 'stopLoss', price: 95 }, instrument, profitText: text });
  assert.equal(multiple.preview.quantity, '1', 'a new allocated level starts at the minimum quantity');
  assert.deepEqual(proposedEditPoint({ ...edit, leg: 'stopLoss', order: { ...edit.order, stopLoss: 94, exitLevels: [{ id: 'chart:7', qty: 1, stopLoss: 93 }] } }), { price: 93, leg: 'stopLoss' });
  assert.deepEqual(proposedEditPoint(edit), { price: 100 });
  assert.equal(proposedEditPoint({ ...edit, kind: 'position', order: { symbol: 'X', side: 1, qty: 1, avgPrice: 5 } }), undefined);
});

test("U08: Positions and orders, reverse and execution settings hide and restore their overlays", async () => {
  const f = fixture({ brokerConfig: undefined }); await f.session.ready;
  const a = f.chart("A");
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush();
  const live = (kind) => a.overlays.filter((overlay) => !overlay.removed && overlay.spec.kind === kind);
  const position = live("position")[0];
  assert(position, "the profile starts with a position");
  const reversible = position.spec.actions.includes("reverse");
  f.session.updateDisplaySettings({ showReverse: false }); await flush();
  const actions = position.updates.findLast((patch) => patch.actions)?.actions ?? position.spec.actions;
  assert.equal(actions.includes("reverse"), false, "the reverse button setting removes the action");
  f.session.updateDisplaySettings({ showReverse: true }); await flush();
  assert.equal((position.updates.findLast((patch) => patch.actions)?.actions ?? position.spec.actions).includes("reverse"), reversible);
  f.session.updateDisplaySettings({ showPositions: false, showOrders: false }); await flush();
  assert.equal(position.removed, true);
  assert.equal(live("position").length + live("order").length + live("bracket").length, 0);
  f.session.updateDisplaySettings({ showPositions: true, showOrders: true }); await flush();
  assert.equal(live("position").length, 1, "positions return when shown again");
  f.session.host.executionUpdate({ id: "E1", symbol: "SIM:X", price: 99, qty: 2, side: Side.Buy, time: 1_700_000_000_000 }); await flush();
  const execution = live("execution")[0];
  assert(execution, "an execution mark is drawn");
  assert.equal(execution.spec.label, "", "execution labels are off by default");
  f.session.updateDisplaySettings({ showExecutionLabels: true }); await flush();
  assert.equal(execution.updates.findLast((patch) => patch.label !== undefined)?.label, "Bought 2");
  f.session.updateDisplaySettings({ showExecutions: false }); await flush();
  assert.equal(execution.removed, true);
  coordinator.destroy(); f.session.destroy();
});

test("U08: extended lines and alignment reach every chart once per real change", async () => {
  const f = fixture(); await f.session.ready;
  const a = f.chart("A"), b = f.chart("B"), layouts = { A: [], B: [] };
  a.port.setLineLayout = (layout) => layouts.A.push(layout);
  b.port.setLineLayout = (layout) => layouts.B.push(layout);
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush();
  assert.deepEqual(layouts.A, [{ extendLeft: true, alignment: "right" }], "the reference default is sent before lines are drawn");
  f.session.updateDisplaySettings({ showReverse: false }); await flush();
  assert.equal(layouts.A.length, 1, "unrelated settings do not resend the layout");
  f.session.updateDisplaySettings({ lineAlignment: "center", extendLines: false }); await flush();
  assert.deepEqual(layouts.A.at(-1), { extendLeft: false, alignment: "center" });
  assert.deepEqual(layouts.B, layouts.A);
  coordinator.destroy(); f.session.destroy();
});

async function legGesture(options = {}) {
  const f = fixture(options); await f.session.ready;
  f.session.host.orderUpdate({ id: 'leg-order', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98 });
  const chart = f.chart('legs'), actions = [];
  const narrow = new ValueStore(false);
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action), () => {}, narrow);
  await flush();
  const overlay = chart.overlays.find(value => value.spec.entityId === 'leg-order' && !value.removed);
  const pipBefore = f.simulation.controls.subscriptionCounts().pip;
  assert(overlay.spec.protection.handles.includes('takeProfit'));
  overlay.fire({ type: 'dragStart', gestureId: 'G', leg: 'takeProfit', price: 98 });
  overlay.fire({ type: 'dragPreview', gestureId: 'G', leg: 'takeProfit', price: 104 });
  assert(f.session.chartEdits.state.get(), 'the drag opens an edit');
  return { f, chart, overlay, actions, coordinator, narrow, pipBefore };
}
test('OC06: losing bracket permission mid-drag cancels the leg gesture and releases its lease and edit', async () => {
  const { f, overlay, actions, coordinator, pipBefore } = await legGesture();
  try {
    f.session.host.patchConfig({ supportModifyBrackets: false });
    assert.equal(overlay.cancels, 1);
    assert.equal(f.session.chartEdits.state.get(), undefined);
    assert.equal(f.simulation.controls.subscriptionCounts().pip, pipBefore);
    overlay.fire({ type: 'dragCommit', gestureId: 'G', leg: 'takeProfit', price: 104 }); await flush();
    assert.equal(actions.length, 0);
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('OC06: a dragCommit on a withdrawn leg dispatches nothing and ends the gesture with the broker price restored', async () => {
  const f = fixture(); await f.session.ready;
  f.session.host.orderUpdate({ id: 'withdrawn', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98, takeProfit: 105 });
  const chart = f.chart('withdrawn'), actions = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, action => actions.push(action)); await flush();
  try {
    const overlay = chart.overlays.find(value => value.spec.entityId === 'withdrawn' && !value.removed);
    assert.deepEqual(overlay.spec.protection.handles, ['stopLoss']);
    const pipBefore = f.simulation.controls.subscriptionCounts().pip;
    overlay.fire({ type: 'dragStart', gestureId: 'W', leg: 'stopLoss', price: 98 });
    overlay.fire({ type: 'dragPreview', gestureId: 'W', leg: 'stopLoss', price: 95 });
    overlay.fire({ type: 'dragCommit', gestureId: 'W', leg: 'takeProfit', price: 110 }); await flush();
    assert.equal(actions.length, 0);
    assert.equal(f.session.chartEdits.state.get(), undefined);
    assert.equal(f.simulation.controls.subscriptionCounts().pip, pipBefore);
    assert.equal(overlay.updates.at(-1).price, 98);
    overlay.fire({ type: 'dragCommit', gestureId: 'W', leg: 'stopLoss', price: 95 }); await flush();
    assert.equal(actions.length, 0, 'the ended gesture accepts no later commit');
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('OC06: a narrow flip mid-drag cancels a leg gesture the compact line no longer offers', async () => {
  const { f, overlay, coordinator, narrow, pipBefore } = await legGesture();
  try {
    narrow.set(true);
    assert.equal(overlay.cancels, 1);
    assert.equal(f.session.chartEdits.state.get(), undefined);
    assert.equal(f.simulation.controls.subscriptionCounts().pip, pipBefore);
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('OC06: turning multiple exit levels off mid-drag cancels a leg the single pair no longer offers', async () => {
  const f = fixture(); await f.session.ready;
  f.session.host.patchConfig({ supportMultipleExitLevels: true });
  f.session.updateDisplaySettings({ multipleExitLevels: true });
  f.session.host.orderUpdate({ id: 'levels', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98, takeProfit: 105 });
  const chart = f.chart('levels');
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}); await flush();
  try {
    const overlay = chart.overlays.find(value => value.spec.entityId === 'levels' && !value.removed);
    assert(overlay.spec.protection.handles.includes('takeProfit'));
    overlay.fire({ type: 'dragStart', gestureId: 'L', leg: 'takeProfit', price: 98 });
    assert(f.session.chartEdits.state.get());
    f.session.updateDisplaySettings({ multipleExitLevels: false });
    assert.equal(overlay.cancels, 1);
    assert.equal(f.session.chartEdits.state.get(), undefined);
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('OC06/X04: removing the overlay mid-drag clears the edit; destroy and account switch release the pip lease', async () => {
  const first = await legGesture();
  try {
    first.f.session.host.orderUpdate({ ...first.f.session.state.orders.get('leg-order'), symbol: 'SIM:Y' });
    assert.equal(first.overlay.removed, true);
    assert.equal(first.f.session.chartEdits.state.get(), undefined);
    assert.equal(first.f.simulation.controls.subscriptionCounts().pip, first.pipBefore);
  } finally { first.coordinator.destroy(); first.f.session.destroy(); }
  const second = await legGesture();
  second.coordinator.destroy();
  assert.equal(second.f.simulation.controls.subscriptionCounts().pip, 0);
  assert.equal(second.f.session.chartEdits.state.get(), undefined);
  second.f.session.destroy();
});
test('B04/X09: exits of a waiting market order follow the quote; exits of a limit parent are not re-projected', async () => {
  const f = fixture(); await f.session.ready;
  const releaseQuotes = f.session.acquireQuotes('SIM:X', 'fast', () => {}); await flush(); await flush();
  const market = { id: 'follow-market', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Market, status: OrderStatus.Working };
  const limit = { id: 'follow-limit', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 95 };
  f.session.host.orderUpdate(market); f.session.host.orderUpdate(limit);
  f.session.host.orderUpdate({ ...linkedOrder('follow-market-tp', market.id, ParentType.Order), limitPrice: 120, status: OrderStatus.Inactive });
  f.session.host.orderUpdate({ ...linkedOrder('follow-limit-tp', limit.id, ParentType.Order), limitPrice: 120, status: OrderStatus.Inactive });
  const chart = f.chart('A');
  let forbidIds = false;
  const orders = { ...f.session.state.orders, ids() { if (forbidIds) assert.fail('a quote enumerated order IDs'); return f.session.state.orders.ids(); } };
  const coordinator = createOverlayCoordinator({ ...f.session, state: { ...f.session.state, orders } }, f.collection, () => {});
  await flush();
  const marketTp = chart.overlays.find(value => value.spec.entityId === 'follow-market-tp' && !value.removed);
  const limitTp = chart.overlays.find(value => value.spec.entityId === 'follow-limit-tp' && !value.removed);
  const limitUpdates = limitTp.updates.length, before = marketTp.updates.length;
  forbidIds = true;
  f.session.host.realtimeUpdate('SIM:X', { ask: 104.5, bid: 104.4, trade: 104.45 });
  forbidIds = false;
  const patch = marketTp.updates.slice(before).findLast(update => update.protection);
  assert(patch, 'the market parent exit is re-projected');
  assert.equal(patch.protection.entryPrice, 104.5);
  assert.notEqual(patch.protection.preview.text, marketTp.spec.protection.preview.text);
  assert.equal(limitTp.updates.length, limitUpdates, 'the limit parent exit is untouched');
  releaseQuotes(); coordinator.destroy(); f.session.destroy();
});
test('P02: a broker without pip-value streams drags money exits without an error and estimates from the static pip value', async () => {
  const f = fixture({ configureBroker: broker => { broker.subscribePipValue = undefined; broker.unsubscribePipValue = undefined; } });
  await f.session.ready;
  assert.equal(f.session.policy.get().pipValues, false);
  f.session.host.orderUpdate({ id: 'static-pip', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98 });
  f.session.host.orderUpdate({ id: 'static-pip-tp', symbol: 'SIM:X', side: Side.Sell, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 101, parentId: 'static-pip', parentType: ParentType.Order });
  const chart = f.chart('static'), errors = [];
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, error => errors.push(error)); await flush();
  try {
    const parent = chart.overlays.find(value => value.spec.entityId === 'static-pip' && !value.removed);
    const child = chart.overlays.find(value => value.spec.entityId === 'static-pip-tp' && !value.removed);
    const shown = (child.updates.filter(update => update.protection).at(-1) ?? child.spec).protection;
    assert.match(shown.preview.text, /USD/, 'the confirmed exit shows money from the static pip value');
    parent.fire({ type: 'dragStart', gestureId: 'P', leg: 'stopLoss', price: 98 });
    parent.fire({ type: 'dragPreview', gestureId: 'P', leg: 'stopLoss', price: 96 });
    assert.match(parent.updates.at(-1).protection.preview.text, /USD/);
    assert.deepEqual(errors, []);
    assert.equal(f.simulation.controls.subscriptionCounts().pip, 0);
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('X09/X05: a burst of quotes re-projects each affected overlay once per frame; a drag preview during the burst is immediate', async () => {
  const f = fixture({ brokerConfig: { configFlags: { supportPLUpdate: false } } }); await f.session.ready;
  for (let i = 0; i < 3; i++) f.session.host.positionUpdate({ id: `burst-${i}`, symbol: 'SIM:X', side: 1, qty: 2, avgPrice: 100 });
  const market = { id: 'burst-market', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Market, status: OrderStatus.Working };
  f.session.host.orderUpdate(market);
  f.session.host.orderUpdate({ ...linkedOrder('burst-tp', market.id, ParentType.Order), limitPrice: 120, status: OrderStatus.Inactive });
  f.session.host.orderUpdate({ id: 'burst-limit', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 95 });
  const chart = f.chart('burst'), frames = [];
  const frame = callback => { frames.push(callback); return () => { const index = frames.indexOf(callback); if (index >= 0) frames.splice(index, 1); }; };
  const runFrames = () => { while (frames.length) frames.shift()(); };
  const coordinator = createOverlayCoordinator(f.session, f.collection, () => {}, () => {}, undefined, frame);
  await flush(); await flush(); runFrames();
  try {
    f.simulation.controls.quote('SIM:X', 101); await flush(); runFrames();
    const overlays = chart.overlays.filter(value => !value.removed);
    const counts = () => overlays.map(value => value.updates.length);
    const before = counts();
    const limit = overlays.find(value => value.spec.entityId === 'burst-limit');
    limit.fire({ type: 'dragStart', gestureId: 'B', leg: 'takeProfit', price: 95 });
    for (let tick = 0; tick < 50; tick++) {
      f.simulation.controls.quote('SIM:X', 102 + tick / 100);
      if (tick === 25) {
        const previews = limit.updates.length;
        limit.fire({ type: 'dragPreview', gestureId: 'B', leg: 'takeProfit', price: 99 });
        assert.equal(limit.updates.length, previews + 1, 'the preview is not deferred to the frame');
      }
    }
    await flush();
    assert.equal(f.session.state.quotes.get('SIM:X').bid !== undefined, true, 'store writes stay synchronous');
    assert.equal(frames.length, 1, 'one frame is scheduled for the whole burst');
    runFrames();
    const after = counts();
    for (const [index, overlay] of overlays.entries()) {
      const delta = after[index] - before[index] - (overlay === limit ? 1 : 0);
      if (overlay.spec.kind === 'position' || overlay.spec.entityId === 'burst-tp') assert.equal(delta, 1, `${overlay.spec.entityId} re-projects once`);
      else assert.equal(delta, 0, `${overlay.spec.entityId} is not quote-driven`);
    }
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('X09: a store change that leaves position and exit presence unchanged does no finance synchronization work', async () => {
  const f = fixture(); await f.session.ready;
  const parent = { id: 'sync-parent', symbol: 'SIM:X', side: Side.Buy, qty: 2, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 98 };
  f.session.host.orderUpdate(parent);
  f.session.host.orderUpdate({ ...parent, id: 'sync-tp', parentId: parent.id, parentType: ParentType.Order, side: Side.Sell, limitPrice: 101 });
  f.chart('sync');
  let syncs = 0, leases = 0;
  const counted = { ...f.session, acquireFinancial: (...args) => { leases++; return f.session.acquireFinancial(...args); } };
  const coordinator = createOverlayCoordinator(counted, f.collection, () => {}, () => {}, undefined, undefined, { financialSync: () => syncs++ });
  await flush(); await flush(); await flush();
  try {
    const revision = f.session.symbolOptionsRevision.get();
    assert(syncs > 0, 'the probe counts real synchronizations');
    syncs = 0; leases = 0;
    // Another order on the chart symbol is placed and fills: position and exit presence are unchanged.
    f.session.host.orderUpdate({ id: 'other', symbol: 'SIM:X', side: Side.Buy, qty: 1, type: OrderType.Limit, status: OrderStatus.Working, limitPrice: 97 });
    f.session.host.orderUpdate({ id: 'other', symbol: 'SIM:X', side: Side.Buy, qty: 1, type: OrderType.Limit, status: OrderStatus.Filled, limitPrice: 97, filledQty: 1 });
    assert.equal(f.session.symbolOptionsRevision.get(), revision, 'no symbol options loaded meanwhile');
    assert.equal(leases, 0, 'no finance lease churn');
    assert.equal(syncs, 0, 'no finance synchronization work');
    f.session.updateDisplaySettings({ showBracketProfit: false });
    assert.equal(syncs, 1, 'a real input change synchronizes once');
  } finally { coordinator.destroy(); f.session.destroy(); }
});
test('X09/A04: connection writes that leave readiness, generation and account unchanged do not rebuild projections', async () => {
  const f = fixture(); await f.session.ready;
  f.chart('notices');
  let enumerations = 0;
  const orders = { ...f.session.state.orders, ids() { enumerations++; return f.session.state.orders.ids(); } };
  const coordinator = createOverlayCoordinator({ ...f.session, state: { ...f.session.state, orders } }, f.collection, () => {}); await flush();
  try {
    // A rebuild enumerates the order store twice (bracket links, then projections).
    enumerations = 0;
    await f.session.refresh();
    assert.equal(f.session.state.connection.get().phase, 'ready');
    assert.equal(enumerations / 2, 2, 'ready → hydrating → ready rebuilds twice; the account-identity write does not');
  } finally { coordinator.destroy(); f.session.destroy(); }
});
