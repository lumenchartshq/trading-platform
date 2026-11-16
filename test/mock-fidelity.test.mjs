import { simulatedSession } from "./support/session-fixture.mjs";
// Simulated broker fidelity: orderings and transitions a live broker produces, exercised through a real session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { flush } from "./manual-clock.mjs";
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
const { OrderStatus, OrderType, Side } = await loadModule("src/contracts/broker.ts");

const limitOrder = { symbol: "SIM:X", side: Side.Buy, qty: 2, type: OrderType.Limit, limitPrice: 100 };

/** Records when broker promises settle relative to host order updates. */
function traceOrdering(broker, host, methods) {
  const events = [];
  const orderUpdate = host.orderUpdate.bind(host);
  host.orderUpdate = (order) => {
    events.push(`update:${order.status}`);
    orderUpdate(order);
  };
  for (const method of methods) {
    const original = broker[method].bind(broker);
    broker[method] = (...args) =>
      original(...args).then((value) => {
        events.push(`resolved:${method}`);
        return value;
      });
  }
  return events;
}

test("O01: under after and split orderings, place, modify and cancel confirm when updates follow promise fulfilment", async () => {
  for (const ordering of ["after", "split"]) {
    let events;
    const { simulation, session } = await simulatedSession({
      simulation: createDeterministicBroker({ updateOrdering: ordering }),
      configureBroker: (broker, host) => {
        events = traceOrdering(broker, host, ["placeOrder", "modifyOrder", "cancelOrder"]);
      },
    });
    try {
      const placed = await session.commands.place({
        context: session.commands.context(),
        order: { ...limitOrder, takeProfit: 110, stopLoss: 90 },
      });
      assert.equal(placed.outcome, "confirmed", ordering);
      const placeEvents = events.splice(0);
      const resolvedAt = placeEvents.indexOf("resolved:placeOrder");
      assert(resolvedAt >= 0, ordering);
      const before = placeEvents.slice(0, resolvedAt).filter((event) => event.startsWith("update:"));
      assert.equal(before.length, ordering === "split" ? 1 : 0, `${ordering}: ${placeEvents.join(",")}`);
      assert(
        placeEvents.slice(resolvedAt + 1).some((event) => event.startsWith("update:")),
        ordering,
      );
      const id = placed.entityIds[0];
      const modified = { ...session.state.orders.get(id), limitPrice: 99 };
      const modify = await session.commands.modify({ context: session.commands.context(id), order: modified });
      assert.equal(modify.outcome, "confirmed", ordering);
      assert.equal(session.state.orders.get(id).limitPrice, 99, ordering);
      const cancel = await session.commands.cancel({ context: session.commands.context(id), id });
      assert.equal(cancel.outcome, "confirmed", ordering);
      assert.equal(session.state.orders.get(id).status, OrderStatus.Canceled, ordering);
    } finally {
      session.destroy();
    }
  }
});

test("O01: controls.updateOrdering switches a live simulation between before, after and split", async () => {
  let events;
  const { simulation, session } = await simulatedSession({
    configureBroker: (broker, host) => {
      events = traceOrdering(broker, host, ["placeOrder"]);
    },
  });
  try {
    for (const [ordering, updatesBefore] of [
      ["before", 1],
      ["after", 0],
      ["split", 1],
    ]) {
      simulation.controls.updateOrdering(ordering);
      events.length = 0;
      const placed = await session.commands.place({ context: session.commands.context(), order: limitOrder });
      assert.equal(placed.outcome, "confirmed", ordering);
      const resolvedAt = events.indexOf("resolved:placeOrder");
      assert.equal(events.slice(0, resolvedAt).length, updatesBefore, `${ordering}: ${events.join(",")}`);
      await flush();
      assert.equal(events.length, 2, ordering);
    }
  } finally {
    session.destroy();
  }
});

test("O04: under after and split orderings, a missing orderId still confirms the unique new order", async () => {
  for (const ordering of ["after", "split"]) {
    let events;
    const { simulation, session } = await simulatedSession({
      simulation: createDeterministicBroker({ updateOrdering: ordering }),
      configureBroker: (broker, host) => {
        events = traceOrdering(broker, host, ["placeOrder"]);
        const placeOrder = broker.placeOrder.bind(broker);
        broker.placeOrder = (...args) => placeOrder(...args).then(() => ({}));
      },
    });
    try {
      const placed = await session.commands.place({
        context: session.commands.context(),
        order: { ...limitOrder, takeProfit: 110 },
      });
      assert.equal(placed.outcome, "confirmed", ordering);
      assert.equal(events.indexOf("resolved:placeOrder"), ordering === "split" ? 1 : 0, events.join(","));
      const id = placed.entityIds[0];
      assert(id, ordering);
      assert.equal(session.state.orders.get(id).status, OrderStatus.Working, ordering);
      assert.equal(simulation.controls.calls().filter((call) => call.method === "placeOrder").length, 1, ordering);
    } finally {
      session.destroy();
    }
  }
});

test("B03: on fx-netting, an individual-position bracket fill reduces that individual and cancels its sibling leg", async () => {
  for (const [fillQty, remaining] of [
    [4, 0],
    [1, 3],
  ]) {
    const { simulation, session } = await simulatedSession({
      simulation: createDeterministicBroker({ profile: "fx-netting" }),
    });
    try {
      const individuals = session.state.individualPositions;
      const id = individuals.ids()[0];
      const netId = session.state.positions.ids()[0];
      const before = individuals.get(id);
      const netBefore = session.state.positions.get(netId).qty;
      const individualCount = individuals.ids().length;
      const edit = await session.commands.editProtection({
        id,
        individual: true,
        context: session.commands.context(id, "individualPosition"),
        brackets: { takeProfit: 110, stopLoss: 90 },
      });
      assert.equal(edit.outcome, "confirmed");
      const legs = simulation.controls.snapshot().orders.filter((order) => order.parentId === id);
      const take = legs.find((order) => order.type === OrderType.Limit);
      const stop = legs.find((order) => order.type === OrderType.Stop);
      simulation.controls.fill(take.id, fillQty, 110);
      await flush();
      assert.equal(individuals.get(id)?.qty ?? 0, remaining, `fill ${fillQty}`);
      assert.equal(individuals.get(id)?.side ?? before.side, before.side, "the individual is reduced, never flipped");
      assert.equal(
        individuals.ids().length,
        remaining ? individualCount : individualCount - 1,
        "no opposite individual",
      );
      assert.equal(session.state.positions.get(netId)?.qty ?? 0, netBefore - fillQty, "the net position follows");
      assert.equal(session.state.orders.get(stop.id).status, OrderStatus.Canceled, "the sibling leg is cancelled");
    } finally {
      session.destroy();
    }
  }
});

const near = (actual, expected, message) =>
  assert(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} !== ${expected}`);

/** Records host P&L pushes so the test sees the broker channel, not a platform estimate. */
function tracePL(host) {
  const pushes = [];
  for (const method of ["plUpdate", "individualPositionPLUpdate"]) {
    const original = host[method].bind(host);
    host[method] = (id, value) => {
      pushes.push({ method, id, value });
      original(id, value);
    };
  }
  return pushes;
}

test("P01: closes and fills realise P&L net of commission into equity, the summary value and equityUpdate", async () => {
  const { simulation, session, broker } = await simulatedSession();
  try {
    const release = session.acquireFinancial("equity");
    await flush();
    const summary = () => broker.accountManagerInfo().summary[0].wValue.value();
    assert.equal(session.state.equity.get(), 10000);
    const netId = session.state.positions.ids()[0];
    const position = session.state.positions.get(netId);
    assert.deepEqual([position.qty, position.side, position.avgPrice], [4, Side.Buy, 99]);
    const closed = await session.commands.close({
      id: netId,
      amount: 2,
      context: session.commands.context(netId, "position"),
    });
    assert.equal(closed.outcome, "confirmed");
    // Quote 100 against average 99 on 2 units, less 0.10 commission.
    near(session.state.equity.get(), 10000 + 2 - 0.1, "close");
    near(summary(), session.state.equity.get(), "summary");
    const placed = await session.commands.place({
      context: session.commands.context(),
      order: { symbol: "SIM:X", side: Side.Sell, qty: 1, type: OrderType.Market },
    });
    simulation.controls.fill(placed.entityIds[0], 1, 101);
    await flush();
    near(session.state.equity.get(), 10000 + 2 - 0.1 + 2 - 0.1, "fill");
    near(summary(), session.state.equity.get(), "summary");
    release();
  } finally {
    session.destroy();
  }
});

test("P01: ticks push broker P&L for open net and individual positions only when supportPLUpdate is set", async () => {
  for (const [profile, expected] of [
    ["equity-net", ["plUpdate"]],
    ["fx-netting", ["plUpdate", "individualPositionPLUpdate"]],
    ["equity-estimates", []],
  ]) {
    let pushes;
    const { simulation, session } = await simulatedSession({
      simulation: createDeterministicBroker({ profile }),
      configureBroker: (_broker, host) => {
        pushes = tracePL(host);
      },
    });
    try {
      const price = simulation.controls.tick();
      assert.deepEqual([...new Set(pushes.map((push) => push.method))], expected, profile);
      for (const push of pushes) {
        const position =
          push.method === "plUpdate"
            ? session.state.positions.get(push.id)
            : session.state.individualPositions.get(push.id);
        const average = push.method === "plUpdate" ? position.avgPrice : position.price;
        near(push.value, (price - average) * position.qty * position.side, `${profile} ${push.method}`);
      }
    } finally {
      session.destroy();
    }
  }
});

test("C02: native reverse through the mock closes, refills 2x quantity at the quote in two executions and cancels protection", async () => {
  for (const profile of ["equity-net", "fx-netting"]) {
    const { simulation, session } = await simulatedSession({ simulation: createDeterministicBroker({ profile }) });
    try {
      simulation.controls.quote("SIM:X", 102);
      const netId = session.state.positions.ids()[0];
      const before = session.state.positions.get(netId);
      const protectedId = profile === "fx-netting" ? session.state.individualPositions.ids()[0] : netId;
      const protection = await session.commands.editProtection({
        id: protectedId,
        individual: profile === "fx-netting",
        context: session.commands.context(protectedId, profile === "fx-netting" ? "individualPosition" : "position"),
        brackets: { takeProfit: 110, stopLoss: 90 },
      });
      assert.equal(protection.outcome, "confirmed", profile);
      const legs = simulation.controls.snapshot().orders.filter((order) => order.parentId === protectedId);
      assert.equal(legs.length, 2, profile);
      const executions = session.state.executions.ids().length;
      const reversed = await session.commands.reverse({
        id: netId,
        context: session.commands.context(netId, "position"),
      });
      assert.equal(reversed.outcome, "confirmed", profile);
      const after = session.state.positions.get(netId);
      assert.deepEqual([after.side, after.qty, after.avgPrice], [-before.side, before.qty, 102], profile);
      const fills = session.state.executions
        .ids()
        .slice(executions)
        .map((id) => session.state.executions.get(id));
      assert.deepEqual(
        fills.map((execution) => [execution.side, execution.qty, execution.price]),
        [
          [-before.side, before.qty, 102],
          [-before.side, before.qty, 102],
        ],
        `${profile}: one closing and one opening execution`,
      );
      for (const leg of legs) assert.equal(session.state.orders.get(leg.id).status, OrderStatus.Canceled, profile);
      if (profile === "fx-netting") {
        const individuals = session.state.individualPositions
          .ids()
          .map((id) => session.state.individualPositions.get(id));
        assert.deepEqual(
          individuals.map((position) => [position.side, position.qty]),
          [[-before.side, before.qty]],
          "individuals follow the reversed net position",
        );
      }
      const calls = simulation.controls.calls().map((call) => call.method);
      assert.equal(calls.filter((method) => method === "reversePosition").length, 1, profile);
      assert.equal(calls.filter((method) => method === "placeOrder").length, 0, profile);
    } finally {
      session.destroy();
    }
  }
});

test("B01: modifying a parent order's quantity keeps its bracket child IDs and updates them in place", async () => {
  const { simulation, session } = await simulatedSession();
  try {
    const placed = await session.commands.place({
      context: session.commands.context(),
      order: { ...limitOrder, qty: 4, takeProfit: 110, stopLoss: 90 },
    });
    const parentId = placed.entityIds[0];
    const children = () => simulation.controls.snapshot().orders.filter((order) => order.parentId === parentId);
    const before = children();
    assert.equal(before.length, 2);
    const modified = { ...session.state.orders.get(parentId), qty: 6 };
    const result = await session.commands.modify({ context: session.commands.context(parentId), order: modified });
    assert.equal(result.outcome, "confirmed");
    const after = children();
    assert.equal(after.length, before.length, "no replacement children are created");
    assert.deepEqual(
      after.map((child) => child.id).sort(),
      before.map((child) => child.id).sort(),
      "children keep their broker IDs",
    );
    for (const child of after) {
      assert.equal(child.status, OrderStatus.Inactive);
      assert.equal(session.state.orders.get(child.id).qty, 6, "the surviving leg follows the parent quantity");
    }
    const take = after.find((child) => child.type === OrderType.Limit);
    const stop = after.find((child) => child.type === OrderType.Stop);
    const withoutStop = { ...session.state.orders.get(parentId), stopLoss: undefined, takeProfit: 112 };
    const removal = await session.commands.modify({ context: session.commands.context(parentId), order: withoutStop });
    assert.equal(removal.outcome, "confirmed");
    assert.equal(session.state.orders.get(stop.id).status, OrderStatus.Canceled, "a removed leg is cancelled");
    assert.equal(session.state.orders.get(take.id).status, OrderStatus.Inactive, "the surviving leg keeps its ID");
    assert.equal(session.state.orders.get(take.id).limitPrice, 112);
    assert.equal(children().length, 2, "no new leg is created for a surviving exit");
  } finally {
    session.destroy();
  }
});

test("U04: a broker preview confirmId is consumed by its successful use and cannot be replayed", async () => {
  const { session, broker } = await simulatedSession();
  try {
    const { confirmId } = await broker.previewOrder(limitOrder);
    await broker.placeOrder(limitOrder, confirmId);
    await assert.rejects(broker.placeOrder(limitOrder, confirmId), /stale/);
    const second = await broker.previewOrder(limitOrder);
    await assert.rejects(broker.placeOrder({ ...limitOrder, qty: 3 }, second.confirmId), /stale/);
    await broker.placeOrder(limitOrder, second.confirmId);
  } finally {
    session.destroy();
  }
});

test("U04: a broker preview expires after controls.previewTtl on the simulation clock", async () => {
  const { simulation, session } = await simulatedSession();
  try {
    simulation.controls.previewTtl(1000);
    const request = { context: session.commands.context(), order: limitOrder };
    const fresh = await session.commands.preview(request);
    simulation.clock.advance(999);
    const placed = await session.commands.place({
      ...request,
      previewToken: fresh.token,
      confirmId: fresh.preview.confirmId,
    });
    assert.equal(placed.outcome, "confirmed");
    const stale = await session.commands.preview({ ...request, context: session.commands.context() });
    simulation.clock.advance(1001);
    await assert.rejects(
      session.commands.place({
        ...request,
        context: session.commands.context(),
        previewToken: stale.token,
        confirmId: stale.preview.confirmId,
      }),
      (error) => error.code === "broker-rejected",
    );
  } finally {
    session.destroy();
  }
});

test("A02: while disconnected the broker rejects reads and withholds pushes, so reconnect re-reads scripted fills", async () => {
  const { simulation, session, broker } = await simulatedSession();
  try {
    const placed = await session.commands.place({ context: session.commands.context(), order: limitOrder });
    const id = placed.entityIds[0];
    const netId = session.state.positions.ids()[0];
    const netBefore = session.state.positions.get(netId).qty;
    simulation.controls.disconnect();
    await assert.rejects(broker.orders(), /disconnected/);
    await assert.rejects(broker.positions(), /disconnected/);
    simulation.controls.quote("SIM:X", 101);
    simulation.controls.fill(id, 2, 101);
    await flush();
    assert.equal(session.state.orders.get(id).status, OrderStatus.Working, "no push reaches the platform while down");
    assert.equal(session.state.positions.get(netId).qty, netBefore);
    simulation.controls.reconnect();
    await flush();
    await flush();
    assert.notEqual(session.state.orders.get(id)?.status, OrderStatus.Working, "the filled order is re-read");
    assert.equal(session.state.positions.get(netId).qty, netBefore + 2, "the position is re-read after reconnect");
  } finally {
    session.destroy();
  }
});
test("C05: the mock honours close previews: an unknown or reused confirmId is rejected, a fresh one closes once", async () => {
  const simulation = createDeterministicBroker();
  const { session, broker } = await simulatedSession({ simulation });
  try {
    const positionId = session.state.positions.ids()[0];
    await assert.rejects(broker.closePosition(positionId, 1, "made-up"), /stale/);
    const preview = await simulation.extensions.previewClosePosition({ accountId: "A", positionId, individual: false, amount: 1 });
    await assert.rejects(broker.closePosition(positionId, 2, preview.id), /stale/, "a different amount is not the reviewed close");
    await broker.closePosition(positionId, 1, preview.id);
    await assert.rejects(broker.closePosition(positionId, 1, preview.id), /stale/, "a used preview is consumed");
    assert.equal(simulation.controls.calls().filter((call) => call.method === "closePosition").length, 4);
  } finally { session.destroy(); }
});
test("B02: under multiposition each partial fill opens its own position and the moved exits cover only that position", async () => {
  const simulation = createDeterministicBroker({ profile: "fx-multiposition" });
  const { session } = await simulatedSession({ simulation });
  try {
    const placed = await session.commands.place({
      context: session.commands.context(),
      order: { symbol: "SIM:X", side: Side.Buy, type: OrderType.Limit, qty: 2, limitPrice: 99, takeProfit: 105 },
    });
    const parentId = placed.entityIds[0];
    simulation.controls.fill(parentId, 1, 99); await flush();
    simulation.controls.fill(parentId, 1, 99); await flush();
    const exits = session.state.orders.ids().map((id) => session.state.orders.get(id))
      .filter((order) => "parentId" in order && order.status === OrderStatus.Working && order.limitPrice === 105);
    assert(exits.length >= 1);
    for (const exit of exits) {
      const position = session.state.positions.get(exit.parentId);
      assert(position, "the exit protects an open position");
      assert(exit.qty <= position.qty, `exit ${exit.qty} exceeds its position ${position.qty}`);
    }
  } finally { session.destroy(); }
});
