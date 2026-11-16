import { simulatedSession } from './support/session-fixture.mjs';
// Group B scenario matrix: every state change below is a broker publication; the platform never executes fills.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { deferred, flush } from "./manual-clock.mjs";
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
const { OrderStatus, OrderType, ParentType, Side } = await loadModule("src/contracts/broker.ts");

async function fixture(profile = "equity-net", flags = {}, configure) {
  const f = await simulatedSession({ simulation: createDeterministicBroker({ profile }), flags, configureBroker: configure });
  const { simulation, session } = f;
  const orders = () => session.state.orders.ids().map((id) => session.state.orders.get(id));
  const childrenOf = (parentId) => orders().filter((order) => order.parentId === parentId);
  const sdkCalls = (method) => simulation.controls.calls().filter((call) => call.method === method);
  return { ...f, orders, childrenOf, sdkCalls };
}
const executionMethods = ["placeOrder", "modifyOrder", "cancelOrder", "cancelOrders", "closePosition", "closeIndividualPosition", "reversePosition", "editPositionBrackets", "editIndividualPositionBrackets"];
const commandCount = (f) => f.simulation.controls.calls().filter((call) => executionMethods.includes(call.method)).length;

async function bracketedParent(f, qty = 4, protection = { takeProfit: 105, stopLoss: 95 }) {
  const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", type: OrderType.Limit, side: Side.Buy, qty, limitPrice: 100, ...protection } });
  return placed.entityIds[0];
}

test("B01: inactive bracket children activate and relink to the position only when the broker publishes the fill", async () => {
  const f = await fixture();
  try {
    const parentId = await bracketedParent(f);
    const children = f.childrenOf(parentId);
    assert.equal(children.length, 2);
    assert(children.every((child) => child.status === OrderStatus.Inactive && child.parentType === ParentType.Order));
    const commands = commandCount(f);
    f.simulation.controls.fill(parentId);
    await flush();
    assert.equal(commandCount(f), commands, "a broker fill is not a platform command");
    assert.equal(f.session.state.orders.get(parentId).status, OrderStatus.Filled);
    const position = f.session.state.positions.get(f.childrenOf(f.session.state.positions.ids().find((id) => f.childrenOf(id).length))?.[0]?.parentId);
    assert(position, "children are relinked to the broker position");
    const moved = children.map((child) => f.session.state.orders.get(child.id));
    assert(moved.every((child) => child.status === OrderStatus.Working && child.parentType === ParentType.Position && child.parentId === position.id), "child IDs are preserved across reparenting");
  } finally { f.session.destroy(); }
});

test("B02: partial and final parent fills follow broker quantities; OCO removes the sibling and position only after broker notification", async () => {
  const f = await fixture();
  try {
    const parentId = await bracketedParent(f, 4);
    const positionId = "simulation-A:net:SIM:X";
    const before = f.session.state.positions.get(positionId)?.qty ?? 0;
    f.simulation.controls.fill(parentId, 2);
    await flush();
    assert.equal(f.session.state.orders.get(parentId).status, OrderStatus.Working);
    assert.equal(f.session.state.orders.get(parentId).filledQty, 2);
    assert.equal(f.session.state.positions.get(positionId).qty, before + 2);
    const protectedQty = () => f.childrenOf(positionId).map((child) => child.qty);
    assert.deepEqual(protectedQty(), [2, 2], "partial fill protects only the filled quantity");
    f.simulation.controls.fill(parentId, 2);
    await flush();
    assert.equal(f.session.state.orders.get(parentId).status, OrderStatus.Filled);
    assert.deepEqual(protectedQty(), [4, 4]);
    const [takeProfit, stopLoss] = [OrderType.Limit, OrderType.Stop].map((type) => f.childrenOf(positionId).find((child) => child.type === type));
    // Hold the broker's sibling cancellation to prove the platform does not anticipate OCO.
    const publications = [];
    const cancelSibling = f.host.orderUpdate;
    f.host.orderUpdate = (order) => { if (order.id === stopLoss.id && order.status === OrderStatus.Canceled) publications.push(order); else cancelSibling(order); };
    f.simulation.controls.fill(takeProfit.id, 4, 105);
    await flush();
    assert.equal(f.session.state.orders.get(takeProfit.id).status, OrderStatus.Filled);
    assert.equal(f.session.state.orders.get(stopLoss.id).status, OrderStatus.Working, "sibling stays until the broker cancels it");
    f.host.orderUpdate = cancelSibling;
    for (const order of publications) cancelSibling(order);
    await flush();
    assert.equal(f.session.state.orders.get(stopLoss.id).status, OrderStatus.Canceled);
    assert.equal(f.session.state.positions.get(positionId)?.qty ?? 0, before, "the position closes through the broker's own update");
  } finally { f.session.destroy(); }
});

test("C03: net and individual views keep the broker's distinct IDs and are never aggregated locally", async () => {
  const f = await fixture("fx-netting");
  try {
    const initialIndividuals = f.session.state.individualPositions.ids().length;
    for (const qty of [1, 2]) {
      const placed = await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", type: OrderType.Market, side: Side.Buy, qty } });
      f.simulation.controls.fill(placed.entityIds[0]);
    }
    await flush();
    const snapshot = f.simulation.controls.snapshot();
    assert.deepEqual([...f.session.state.positions.ids()].sort(), snapshot.positions.map((position) => position.id).sort());
    assert.deepEqual([...f.session.state.individualPositions.ids()].sort(), snapshot.individualPositions.map((position) => position.id).sort());
    assert.equal(f.session.state.individualPositions.ids().length, initialIndividuals + 2, "each broker individual position remains separate");
    const netIds = new Set(f.session.state.positions.ids());
    assert(f.session.state.individualPositions.ids().every((id) => !netIds.has(id)), "net and individual IDs are distinct");
    for (const id of f.session.state.positions.ids()) assert.deepEqual(f.session.state.positions.get(id), snapshot.positions.find((position) => position.id === id), "net quantity is the broker's, not a local sum");
  } finally { f.session.destroy(); }
  const multi = await fixture("fx-multiposition");
  try {
    const initial = multi.session.state.positions.ids().length;
    for (let index = 0; index < 2; index++) {
      const placed = await multi.session.commands.place({ context: multi.session.commands.context(), order: { symbol: "SIM:X", type: OrderType.Market, side: Side.Buy, qty: 1 } });
      multi.simulation.controls.fill(placed.entityIds[0]);
    }
    await flush();
    assert.equal(multi.session.state.positions.ids().length, initial + 2, "multiposition entries are not merged");
  } finally { multi.session.destroy(); }
});

test("C04: an individual position without a broker opening time is rejected at intake, so FIFO never orders on invented dates", async () => {
  const f = await fixture("fx-netting", { requiresFIFOCloseIndividualPositions: true });
  try {
    // Rejected at intake as a diagnostic; the host never throws into the adapter.
    assert.doesNotThrow(() => f.host.individualPositionUpdate({ id: "undated", symbol: "SIM:X", side: Side.Buy, qty: 1, price: 100, date: Number.NaN }));
    assert.equal(f.session.state.individualPositions.get("undated"), undefined);
    const id = f.session.state.individualPositions.ids()[0];
    await f.session.commands.close({ id, individual: true, context: f.session.commands.context(id, "individualPosition") });
    assert.deepEqual(f.sdkCalls("closeIndividualPosition").map((call) => call.args[0]), [id]);
  } finally { f.session.destroy(); }
});

test("B06: switching account while a protection edit awaits its review rejects the stale edit and never reaches the broker", async () => {
  const pending = deferred();
  const f = await fixture("equity-net", {}, (broker) => {
    const options = broker.getPositionDialogOptions?.bind(broker);
    broker.getPositionDialogOptions = async (symbol) => { await pending.promise; return options?.(symbol); };
  });
  try {
    const id = f.session.state.positions.ids()[0];
    const context = f.session.commands.context(id, "position");
    await f.session.commands.selectAccount("simulation-B");
    await flush();
    pending.resolve();
    await assert.rejects(f.session.commands.editProtection({ id, context, brackets: { stopLoss: 90 } }), (error) => error.code === "stale-context");
    assert.equal(f.sdkCalls("editPositionBrackets").length, 0);
  } finally { f.session.destroy(); }
});
