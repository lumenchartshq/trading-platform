import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { deferred, flush } from "./manual-clock.mjs";
const { createTicketController } = await loadModule(
  "src/ui/order-ticket/controller.ts",
);
const { createTradingSession } = await loadModule("src/core/session.ts");
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
async function fixture(configure, overrides = {}) {
  const simulation = createDeterministicBroker(),
    factory = simulation.brokerFactory,
    settings = new Map();
  simulation.brokerConfig.configFlags.supportPlaceOrderPreview = true;
  const session = createTradingSession({
    ...simulation,
    ...overrides,
    brokerFactory: (host) => {
      const broker = factory(host);
      configure?.(broker, simulation);
      return broker;
    },
    settings: mapSettings(settings),
    formatters: stringFormatters,
  });
  await session.ready;
  const controller = createTicketController(session);
  await controller.open(
    { id: "chart", generation: 1, symbol: "SIM:X" },
    { type: 1, limitPrice: 100 },
  );
  return { session, controller, simulation };
}
test("U04/O01: ticket confirms a captured draft once and cannot double-submit", async () => {
  const f = await fixture();
  assert.equal(f.controller.state.get().order.qty, 2);
  await f.controller.review();
  assert.equal(f.controller.state.get().phase, "confirming");
  const send = f.controller.send();
  const duplicate = f.controller.send();
  await Promise.all([send, duplicate]);
  assert.equal(f.controller.state.get().phase, "confirmed");
  assert.equal(
    f.simulation.controls.calls().filter((call) => call.method === "placeOrder")
      .length,
    1,
  );
  f.controller.destroy();
  f.session.destroy();
});
test("U03/U04: validator callbacks stay outside immutable snapshots and stale previews cannot display", async () => {
  const preview = deferred();
  const f = await fixture((broker, simulation) => {
    simulation.brokerConfig.configFlags.supportPlaceOrderPreview = true;
    broker.getOrderDialogOptions = async () => ({
      customFields: [
        {
          inputType: "TextField",
          id: "signature",
          title: "Signature",
          value: "",
          validator: (value) => ({
            valid: value === "approved",
            errorMessage: "Enter the approval text.",
          }),
        },
      ],
    });
    broker.previewOrder = () => preview.promise;
  });
  await f.controller.review();
  assert.equal(f.controller.state.get().phase, "error");
  assert.match(f.controller.state.get().error, /approval/);
  f.controller.patch({ customFields: { signature: "approved" } });
  const review = f.controller.review();
  await flush();
  assert.equal(f.controller.state.get().phase, "previewing");
  f.controller.patch({ qty: 3 });
  preview.resolve({ confirmId: "old", sections: [] });
  await review;
  assert.equal(f.controller.state.get().phase, "editing");
  assert.equal(f.controller.state.get().preview, undefined);
  f.controller.destroy();
  f.session.destroy();
});
test("U04/A03: account switching closes drafts and invalid quantities fail before confirmation or broker dispatch", async () => {
  const f = await fixture();
  f.controller.patch({ qty: 0 });
  await f.controller.review();
  assert.equal(f.controller.state.get().phase, "error");
  assert.equal(
    f.simulation.controls.calls().filter((call) => call.method === "placeOrder")
      .length,
    0,
  );
  await f.session.commands.selectAccount("simulation-B");
  assert.equal(f.controller.state.get().phase, "closed");
  f.controller.destroy();
  f.session.destroy();
});
test("U04: broker preview may omit confirmId; the reviewed draft still dispatches once with undefined forwarded", async () => {
  const f = await fixture((broker) => {
    broker.previewOrder = async () => ({
      sections: [{ rows: [{ title: "Fee", value: "0.10 USD" }] }],
    });
  });
  await f.controller.review();
  assert.equal(f.controller.state.get().preview.confirmId, undefined);
  assert.equal(typeof f.controller.state.get().previewToken, "string");
  await f.controller.send();
  assert.equal(f.controller.state.get().phase, "confirmed");
  const calls = f.simulation.controls
    .calls()
    .filter((call) => call.method === "placeOrder");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], undefined);
  f.controller.destroy();
  f.session.destroy();
});

test("P02/U04: refreshing instrument information invalidates an order review and fences late metadata after close", async () => {
  let pending;
  const f = await fixture((broker) => {
    const read = broker.symbolInfo;
    broker.symbolInfo = (symbol) => (pending ? pending.promise : read(symbol));
  });
  try {
    await f.controller.review();
    assert.equal(f.controller.state.get().phase, "confirming");
    pending = deferred();
    const refresh = f.controller.refreshInstrument();
    assert.equal(f.controller.state.get().refreshing, true);
    assert.equal(f.controller.state.get().previewToken, undefined);
    const qty = f.controller.state.get().order.qty;
    f.controller.patch({ qty: 20 });
    await f.controller.review();
    assert.equal(f.controller.state.get().order.qty, qty);
    assert.equal(f.controller.state.get().phase, "editing");
    f.controller.close();
    pending.resolve({ minTick: 0.01, qty: { min: 1, max: 10, step: 1 } });
    await refresh;
    assert.equal(f.controller.state.get().phase, "closed");
    assert.equal(f.controller.state.get().refreshing, false);
    assert.equal(
      f.simulation.controls
        .calls()
        .filter((call) => call.method === "placeOrder").length,
      0,
    );
  } finally {
    f.controller.destroy();
    f.session.destroy();
  }
});

test("U02: new ticket selects broker default and type changes clear inapplicable durations; silent dispatch uses the same default", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.controller.state.get().order.duration, { type: "GTC" });
    f.controller.patch({ type: 2 });
    assert.equal(f.controller.state.get().order.duration, undefined);
    f.controller.patch({ type: 1 });
    assert.deepEqual(f.controller.state.get().order.duration, { type: "GTC" });
    const result = await f.session.commands
      .place({
        context: f.session.commands.context(),
        order: { symbol: "SIM:X", side: 1, type: 1, qty: 2, limitPrice: 100 },
      })
      .catch((error) => error);
    // This fixture requires preview; an unreviewed silent call cannot bypass that policy.
    assert.match(result.message, /Review/);
    const order = {
      symbol: "SIM:X",
      side: 1,
      type: 1,
      qty: 2,
      limitPrice: 100,
    };
    const context = f.session.commands.context();
    const lease = await f.session.commands.preview({ context, order });
    await f.session.commands.place({
      context,
      order,
      previewToken: lease.token,
      confirmId: lease.preview.confirmId,
    });
    const calls = f.simulation.controls.calls();
    assert.deepEqual(
      calls.find((call) => call.method === "previewOrder").args[0].duration,
      { type: "GTC" },
    );
    assert.deepEqual(
      calls.find((call) => call.method === "placeOrder").args[0].duration,
      { type: "GTC" },
    );
    f.session.host.patchConfig({ supportPlaceOrderPreview: false });
    const silent = await f.session.commands.place({ context: f.session.commands.context(), order });
    assert.equal(silent.outcome, "confirmed");
    assert.deepEqual(f.simulation.controls.calls().filter(call => call.method === "placeOrder").at(-1).args[0].duration, { type: "GTC" });
  } finally {
    f.controller.destroy();
    f.session.destroy();
  }
});

test("U02/U04: changing a broker duration default invalidates the normalized order preview before dispatch", async () => {
  const f = await fixture();
  try {
    const order = {
      symbol: "SIM:X",
      side: 1,
      type: 1,
      qty: 2,
      limitPrice: 100,
    };
    const context = f.session.commands.context();
    const lease = await f.session.commands.preview({ context, order });
    f.session.host.setDurations([{ value: "DAY", name: "Day", default: true }]);
    await assert.rejects(
      f.session.commands.place({
        context,
        order,
        previewToken: lease.token,
        confirmId: lease.preview.confirmId,
      }),
      /Review/,
    );
    assert.equal(
      f.simulation.controls
        .calls()
        .filter((call) => call.method === "placeOrder").length,
      0,
    );
  } finally {
    f.controller.destroy();
    f.session.destroy();
  }
});

test("U04/U05: an explicit confirmation preference skips preview and submits place/modify once", async () => {
  const f = await fixture();
  try {
    await f.session.host.setOrderTicketSetting('showOrderPreview', false);
    await Promise.all([f.controller.review(), f.controller.review()]);
    assert.equal(f.controller.state.get().phase, 'confirmed');
    let calls = f.simulation.controls.calls();
    assert.equal(calls.filter(call => call.method === 'previewOrder').length, 0);
    assert.equal(calls.filter(call => call.method === 'placeOrder').length, 1);
    const order = f.simulation.controls.snapshot().orders.find(order => order.type === 1);
    await f.controller.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, order);
    f.controller.patch({ limitPrice: 99 });
    await Promise.all([f.controller.review(), f.controller.review()]);
    assert.equal(f.controller.state.get().phase, 'confirmed');
    calls = f.simulation.controls.calls();
    assert.equal(calls.filter(call => call.method === 'modifyOrder').length, 1);
    assert.equal(calls.filter(call => call.method === 'previewOrder').length, 0);
    await f.session.host.setOrderTicketSetting('showOrderPreview', true);
    await f.controller.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, { type: 1, limitPrice: 98 });
    await f.controller.review(); assert.equal(f.controller.state.get().phase, 'confirming');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'previewOrder').length, 1);
  } finally { f.controller.destroy(); f.session.destroy(); }
});

test("U04/U05: forced confirmation cannot be skipped and an in-flight preview retains its warnings", async () => {
  const forced = await fixture(undefined, { requireConfirmation: true });
  try {
    await assert.rejects(forced.session.host.setOrderTicketSetting('showOrderPreview', false), { code: 'unsupported' });
    await forced.controller.review(); assert.equal(forced.controller.state.get().phase, 'confirming');
    assert.equal(forced.simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 0);
  } finally { forced.controller.destroy(); forced.session.destroy(); }
  const preview = deferred();
  const f = await fixture(broker => { broker.previewOrder = () => preview.promise; });
  try {
    const review = f.controller.review(); await flush();
    await f.session.host.setOrderTicketSetting('showOrderPreview', false);
    preview.resolve({ sections: [], warnings: ['Review this fee'] }); await review;
    assert.equal(f.controller.state.get().phase, 'confirming'); assert.equal(f.controller.state.get().preview.warnings[0], 'Review this fee');
    assert.equal(f.simulation.controls.calls().filter(call => call.method === 'placeOrder').length, 0);
  } finally { f.controller.destroy(); f.session.destroy(); }
});

test("P03/U05: manual quantity edits notify sizing owners, computed updates preserve intent and teardown releases listeners", async () => {
  const f = await fixture(); let resets = 0, defaultWrites = 0;
  const setQty = f.session.host.setQty;
  f.session.host.setQty = (...args) => { defaultWrites++; setQty(...args); };
  const release = f.controller.onManualQuantityChange(() => resets++);
  try {
    for (let update = 0; update < 100; update++) f.controller.patchSizedQuantity(3 + update);
    assert.equal(resets, 0); assert.equal(defaultWrites, 0); assert.equal(await f.session.host.getQty('SIM:X'), 2);
    f.controller.patch({ qty: 4 }); assert.equal(resets, 1); assert.equal(defaultWrites, 1); assert.equal(f.controller.state.get().order.qty, 4);
    release(); f.controller.patch({ qty: 5 }); assert.equal(resets, 1);
    f.controller.onManualQuantityChange(() => resets++); f.controller.destroy();
    f.controller.patch({ qty: 6 }); assert.equal(resets, 1);
  } finally { f.controller.destroy(); f.session.destroy(); }
});
test("U04: after a confirmed order the next draft keeps side, type and quantity, resets entry to the quote and clears protection", async () => {
  const { session, simulation } = await fixture(undefined, {});
  const ticket = createTicketController(session);
  try {
    const release = session.acquireQuotes("SIM:X", "fast", () => {}); await flush();
    simulation.brokerConfig.configFlags.supportPlaceOrderPreview = false;
    await ticket.open({ id: "C", generation: 1, symbol: "SIM:X" }, { side: -1, type: 3, qty: 4, stopPrice: 99.5, takeProfit: 98, stopLoss: 100.5 });
    await ticket.review(); await flush();
    if (ticket.state.get().phase === "confirming") await ticket.send();
    await flush();
    assert.equal(ticket.state.get().phase, "confirmed");
    ticket.startNext();
    const next = ticket.state.get();
    assert.equal(next.phase, "editing");
    assert.equal(next.order.side, -1); assert.equal(next.order.type, 3); assert.equal(next.order.qty, 4);
    assert.equal(next.order.stopPrice, session.state.quotes.get("SIM:X").bid, "entry resets to the quote");
    assert.equal(next.order.takeProfit, undefined); assert.equal(next.order.stopLoss, undefined); assert.equal(next.order.exitLevels, undefined);
    release();
  } finally { ticket.destroy(); session.destroy(); }
});

test('U04/B01: stop-loss memory belongs to the draft controller and resets at lifecycle boundaries', async () => {
  const f = await fixture();
  try {
    f.controller.patchProtection({ stopLoss: 98 });
    assert.equal(f.controller.rememberedStopLoss(), 98);
    f.controller.setStopLoss(undefined);
    assert.equal(f.controller.rememberedStopLoss(), 98);
    f.controller.patch({ side: -1 });
    assert.equal(f.controller.rememberedStopLoss(), undefined);
    f.controller.setStopLoss(102);
    assert.equal(f.controller.rememberedStopLoss(), 102);
    f.controller.close(); assert.equal(f.controller.rememberedStopLoss(), undefined);
    await f.controller.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, { type: 1, limitPrice: 100 });
    f.controller.setStopLoss(99);
    const opening = f.controller.open({ id: 'chart', generation: 1, symbol: 'SIM:X' });
    assert.equal(f.controller.rememberedStopLoss(), undefined);
    await opening;
  } finally { f.controller.destroy(); f.session.destroy(); }
});

test("OC02/U02: draft type changes keep entered prices, fill missing ones and ignore types the symbol does not offer", async () => {
  const f = await fixture();
  try {
    f.controller.changeType(4);
    assert.equal(f.controller.state.get().order.type, 4);
    assert.equal(f.controller.state.get().order.limitPrice, 100);
    assert.equal(f.controller.state.get().order.stopPrice, 100, "the missing trigger starts at the entered limit");
    const revision = f.controller.state.get().revision;
    f.controller.changeType(99);
    assert.equal(f.controller.state.get().revision, revision);
  } finally { f.controller.destroy(); f.session.destroy(); }
});
test("O03/U04: an unconfirmed ticket says it is checking and moves to confirmed when the late match arrives", async () => {
  const f = await fixture();
  await f.controller.review();
  f.simulation.controls.delayNextAcknowledgement(20000);
  const send = f.controller.send(); await flush();
  f.simulation.clock.advance(10000); await send;
  assert.equal(f.controller.state.get().phase, "unconfirmed");
  assert.equal(f.controller.state.get().checking, true);
  for (let second = 0; second < 12 && f.controller.state.get().phase === "unconfirmed"; second++) {
    f.simulation.clock.advance(1000); await flush(); await flush();
  }
  assert.equal(f.controller.state.get().phase, "confirmed");
  assert.equal(f.controller.state.get().checking, undefined);
  assert.equal(f.simulation.controls.calls().filter((call) => call.method === "placeOrder").length, 1);
  f.controller.destroy();
  f.session.destroy();
});
test("O03/U04: a late rejection reaches the ticket; a closed ticket ignores late outcomes", async () => {
  const replies = [];
  const f = await fixture((broker) => {
    broker.placeOrder = () => { const reply = deferred(); replies.push(reply); return reply.promise; };
  });
  await f.controller.review();
  const send = f.controller.send(); await flush();
  f.simulation.clock.advance(10000); await send;
  assert.equal(f.controller.state.get().phase, "unconfirmed");
  replies[0].reject(new Error("Insufficient margin")); await flush(); await flush();
  assert.equal(f.controller.state.get().phase, "error");
  assert.match(f.controller.state.get().error, /could not complete/);
  await f.controller.open({ id: "chart", generation: 1, symbol: "SIM:X" }, { type: 1, limitPrice: 100 });
  await f.controller.review();
  // The first command's key is free again, so a deliberate second order can be sent.
  const second = f.controller.send(); await flush();
  f.simulation.clock.advance(10000); await second;
  assert.equal(f.controller.state.get().phase, "unconfirmed");
  f.controller.close();
  replies[1].resolve({}); await flush();
  assert.equal(f.controller.state.get().phase, "closed");
  for (let second = 0; second < 70; second++) { f.simulation.clock.advance(1000); await flush(); }
  assert.equal(f.controller.state.get().phase, "closed");
  f.controller.destroy();
  f.session.destroy();
});
test("O03/U04: when reconciliation ends without a match the ticket reports an unresolved result", async () => {
  const f = await fixture((broker) => { broker.placeOrder = () => new Promise(() => {}); });
  await f.controller.review();
  const send = f.controller.send(); await flush();
  f.simulation.clock.advance(10000); await send;
  assert.equal(f.controller.state.get().checking, true);
  for (let second = 0; second < 61; second++) { f.simulation.clock.advance(1000); await flush(); }
  assert.equal(f.controller.state.get().phase, "unconfirmed");
  assert.equal(f.controller.state.get().checking, false);
  f.controller.destroy();
  f.session.destroy();
});
test("O01/U04: the ticket says the order reached the broker once it is acknowledged, before confirmation", async () => {
  const replies = [];
  const f = await fixture((broker) => {
    broker.placeOrder = () => { const reply = deferred(); replies.push(reply); return reply.promise; };
  });
  await f.controller.review();
  const send = f.controller.send(); await flush();
  assert.equal(f.controller.state.get().phase, "sending");
  assert.equal(f.controller.state.get().accepted, undefined);
  replies[0].resolve({ orderId: "late-1" }); await flush(); await flush();
  assert.equal(f.controller.state.get().phase, "sending");
  assert.equal(f.controller.state.get().accepted, true);
  f.simulation.clock.advance(10000); await send;
  assert.equal(f.controller.state.get().phase, "unconfirmed");
  assert.equal(f.controller.state.get().accepted, undefined);
  f.controller.destroy();
  f.session.destroy();
});

test("U04: after a confirmed modification the ticket can start a fresh new order", async () => {
  const f = await fixture();
  try {
    await f.session.host.setOrderTicketSetting('showOrderPreview', false);
    await f.controller.review();
    const order = f.simulation.controls.snapshot().orders.find(order => order.type === 1);
    await f.controller.open({ id: 'chart', generation: 1, symbol: 'SIM:X' }, order);
    f.controller.patch({ limitPrice: 99 });
    await f.controller.review();
    assert.equal(f.controller.state.get().phase, 'confirmed');
    assert.ok('id' in f.controller.state.get().order);
    f.controller.startNext(); await flush(); await flush();
    const next = f.controller.state.get();
    assert.equal(next.phase, 'editing');
    assert.equal('id' in next.order, false, 'a new order, not the modified one');
    assert.equal(next.order.symbol, 'SIM:X');
    assert.equal(next.order.limitPrice, undefined);
  } finally { f.controller.destroy(); f.session.destroy(); }
});

test("O03/U04: an unresolved result can start the next order; one still being checked cannot", async () => {
  const f = await fixture((broker) => { broker.placeOrder = () => new Promise(() => {}); });
  try {
    await f.controller.review();
    const send = f.controller.send(); await flush();
    f.simulation.clock.advance(10000); await send;
    assert.equal(f.controller.state.get().checking, true);
    f.controller.startNext();
    assert.equal(f.controller.state.get().phase, 'unconfirmed', 'no new order while the result is still being checked');
    for (let second = 0; second < 61; second++) { f.simulation.clock.advance(1000); await flush(); }
    assert.equal(f.controller.state.get().checking, false);
    f.controller.startNext();
    const next = f.controller.state.get();
    assert.equal(next.phase, 'editing');
    assert.equal(next.order.type, 1);
    assert.equal(next.order.qty, 2);
    assert.deepEqual(next.context, f.session.commands.context(), 'the next order is sent with the current account context');
  } finally { f.controller.destroy(); f.session.destroy(); }
});
