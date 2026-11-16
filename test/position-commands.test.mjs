import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { flush, deferred } from "./manual-clock.mjs";
const { createTradingSession } = await loadModule("src/core/session.ts");
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
const { OrderStatus } = await loadModule("src/contracts/broker.ts");
async function fixture(flags = {}, configure, profile = "equity-net") {
  const simulation = createDeterministicBroker({ profile }),
    factory = simulation.brokerFactory,
    settings = new Map();
  Object.assign(simulation.brokerConfig.configFlags, flags);
  let broker;
  const session = createTradingSession({
    ...simulation,
    brokerFactory: (host) => {
      broker = factory(host);
      configure?.(broker, simulation, host);
      return broker;
    },
    settings: mapSettings(settings),
    formatters: stringFormatters,
  });
  await session.ready;
  const id = session.state.positions.ids()[0];
  return { simulation, session, broker, id };
}
test("C01/C02: native and fallback closing/reversing send the correct side, isClose and quantity", async () => {
  const native = await fixture();
  assert.equal(
    (
      await native.session.commands.close({
        id: native.id,
        context: native.session.commands.context(native.id, "position"),
        amount: 1,
      })
    ).outcome,
    "confirmed",
  );
  assert.equal(native.session.state.positions.get(native.id).qty, 3);
  assert.equal(
    (
      await native.session.commands.reverse({
        id: native.id,
        context: native.session.commands.context(native.id, "position"),
      })
    ).outcome,
    "confirmed",
  );
  assert.equal(native.session.state.positions.get(native.id).side, -1);
  native.session.destroy();
  const fallback = await fixture(
    { supportClosePosition: false, supportNativeReversePosition: false },
    (broker, simulation) => {
      const original = broker.placeOrder;
      broker.placeOrder = async (order) => {
        const result = await original(order);
        simulation.controls.fill(result.orderId);
        return result;
      };
    },
  );
  await fallback.session.commands.close({
    id: fallback.id,
    context: fallback.session.commands.context(fallback.id, "position"),
    amount: 1,
  });
  await fallback.session.commands.reverse({
    id: fallback.id,
    context: fallback.session.commands.context(fallback.id, "position"),
  });
  const places = fallback.simulation.controls
    .calls()
    .filter((call) => call.method === "placeOrder");
  assert.deepEqual(
    places.map((call) => ({
      side: call.args[0].side,
      qty: call.args[0].qty,
      isClose: call.args[0].isClose,
    })),
    [
      { side: -1, qty: 1, isClose: true },
      { side: -1, qty: 6, isClose: true },
    ],
  );
  fallback.session.destroy();
});
test("C01: a native full close uses the held amount below the entry minimum", async () => {
  const quantities = [];
  const f = await fixture({}, (broker, _simulation, host) => {
    const read = broker.positions;
    broker.positions = async () => (await read()).map(row => ({ ...row, qty: 0.25 }));
    broker.closePosition = async (id, amount) => {
      quantities.push(amount);
      const position = (await broker.positions()).find(row => row.id === id);
      host.positionUpdate({ ...position, qty: 0 });
    };
  });
  try {
    const context = f.session.commands.context(f.id, "position");
    await assert.rejects(f.session.commands.close({ id: f.id, amount: 0.1, context }), /allowed range/);
    const result = await f.session.commands.close({ id: f.id, amount: 0.25, context });
    assert.equal(result.outcome, "confirmed");
    assert.deepEqual(quantities, [0.25]);
    assert.equal(f.session.state.positions.get(f.id), undefined);
  } finally {
    f.session.destroy();
  }
});
test("C02/C04: multiposition rejects fallback reverse and FIFO blocks a later individual position", async () => {
  const multi = await fixture(
    { supportNativeReversePosition: false },
    undefined,
    "fx-multiposition",
  );
  await assert.rejects(
    multi.session.commands.reverse({
      id: multi.id,
      context: multi.session.commands.context(multi.id, "position"),
    }),
    (error) => error.code === "unsupported",
  );
  multi.session.destroy();
  const fifo = await fixture(
    { requiresFIFOCloseIndividualPositions: true },
    undefined,
    "fx-netting",
  );
  fifo.session.host.individualPositionUpdate({
    id: "later",
    symbol: "SIM:X",
    date: fifo.simulation.clock.now() + 1000,
    side: 1,
    qty: 1,
    price: 100,
  });
  await assert.rejects(
    fifo.session.commands.close({
      id: "later",
      individual: true,
      context: fifo.session.commands.context("later", "individualPosition"),
    }),
    /earliest/,
  );
  fifo.session.destroy();
});
test("B04/B05: protection validates allocation, serializes one level and waits for linked broker orders", async () => {
  const f = await fixture();
  await assert.rejects(
    f.session.commands.editProtection({
      id: f.id,
      context: f.session.commands.context(f.id, "position"),
      brackets: {
        exitLevels: [{ id: "one", qty: 5, takeProfit: 110, stopLoss: 90 }],
      },
    }),
    /exceeds/,
  );
  const result = await f.session.commands.editProtection({
    id: f.id,
    context: f.session.commands.context(f.id, "position"),
    brackets: {
      exitLevels: [{ id: "one", qty: 4, takeProfit: 110, stopLoss: 90 }],
    },
  });
  assert.equal(result.outcome, "confirmed");
  const edit = f.simulation.controls
    .calls()
    .find((call) => call.method === "editPositionBrackets");
  assert.equal(edit.args[1].exitLevels, undefined);
  assert.equal(edit.args[1].takeProfit, 110);
  assert.equal(
    f.session.state.orders
      .ids()
      .filter((id) => f.session.state.orders.get(id).parentId === f.id).length,
    2,
  );
  f.session.destroy();
  const missing = await fixture({}, (broker, _simulation, host) => {
    broker.editPositionBrackets = async (id, brackets) =>
      host.positionUpdate({
        id,
        symbol: "SIM:X",
        side: 1,
        qty: 4,
        avgPrice: 99,
        ...brackets,
      });
  });
  const pending = missing.session.commands.editProtection({
    id: missing.id,
    context: missing.session.commands.context(missing.id, "position"),
    brackets: { takeProfit: 110, stopLoss: 90 },
  });
  await flush();
  missing.simulation.clock.advance(10000);
  assert.equal((await pending).outcome, "unconfirmed");
  missing.session.destroy();
});
test("O07: bulk cancellation dispatches once and preserves per-order success after mixed broker rejection", async () => {
  let host;
  const f = await fixture({}, (broker, _simulation, adapter) => {
    host = adapter;
    broker.cancelOrders = async (_symbol, _side, ids) => {
      host.orderUpdate({
        id: ids[0],
        symbol: "SIM:X",
        side: 1,
        qty: 1,
        type: 1,
        status: 1,
        limitPrice: 100,
      });
      throw new Error("Second order could not be cancelled");
    };
  });
  for (const id of ["A", "B"])
    host.orderUpdate({
      id,
      symbol: "SIM:X",
      side: 1,
      qty: 1,
      type: 1,
      status: 6,
      limitPrice: 100,
    });
  const results = await f.session.commands.cancelMany({
    context: f.session.commands.context(),
    symbol: "SIM:X",
    orders: ["A", "B"].map((id) => ({
      id,
      revision: f.session.state.orders.revision(id),
    })),
  });
  assert.equal(results[0].result.outcome, "confirmed");
  assert.equal(results[1].error.code, "broker-rejected");
  assert.equal(f.session.state.orders.get("B").status, 6);
  f.session.destroy();
});
test("C05: close-preview extension forwards its optional ID and stale position reviews cannot dispatch", async () => {
  const f = await fixture(
    { supportPreviewClosePosition: true },
    (_broker, simulation) => {
      simulation.extensions.previewClosePosition = async () => ({
        rows: [{ title: "Fee", value: "0.10 USD" }],
      });
    },
  );
  const request = {
    id: f.id,
    context: f.session.commands.context(f.id, "position"),
  };
  const lease = await f.session.commands.previewClose(request);
  assert.equal(lease.preview.id, undefined);
  const result = await f.session.commands.close({
    ...request,
    previewToken: lease.token,
    confirmId: lease.preview.id,
  });
  assert.equal(result.outcome, "confirmed");
  assert.equal(
    f.simulation.controls
      .calls()
      .find((call) => call.method === "closePosition").args[2],
    undefined,
  );
  f.session.destroy();
  const stale = await fixture({ supportPreviewClosePosition: true });
  const old = {
      id: stale.id,
      context: stale.session.commands.context(stale.id, "position"),
    },
    preview = await stale.session.commands.previewClose(old);
  stale.session.host.positionUpdate({
    ...stale.session.state.positions.get(stale.id),
    qty: 3,
  });
  await assert.rejects(
    stale.session.commands.close({
      ...old,
      confirmId: preview.preview.id,
      previewToken: preview.token,
    }),
    (error) => error.code === "stale-context",
  );
  assert.equal(
    stale.simulation.controls
      .calls()
      .filter((call) => call.method === "closePosition").length,
    0,
  );
  stale.session.destroy();
});
test("U05/C05: custom close confirmation replaces presentation and submits exactly once after approval", async () => {
  const f = await fixture(
    { supportPreviewClosePosition: true },
    undefined,
    "custom-ui",
  );
  const closing = f.session.requestClose({
    id: f.id,
    context: f.session.commands.context(f.id, "position"),
  });
  await flush();
  assert.equal(f.session.dialogs.current.get().request.title, "Custom close");
  f.session.dialogs.respond(f.session.dialogs.current.get().id, true);
  assert.equal((await closing).outcome, "confirmed");
  assert.equal(
    f.simulation.controls
      .calls()
      .filter((call) => call.method === "closePosition").length,
    1,
  );
  assert.equal(
    f.simulation.controls
      .calls()
      .filter((call) => call.method === "previewClosePosition").length,
    0,
  );
  f.session.destroy();
});

test('C02: replacement-ID reverse requires an explicit snapshot and excludes preexisting positions', async () => {
  let refreshes = 0;
  const f = await fixture({}, (broker, simulation, host) => {
    const positions = broker.positions;
    let replacement;
    broker.reversePosition = async id => {
      const original = (await positions()).find(position => position.id === id);
      replacement = { ...original, id: 'replacement', side: -original.side };
      host.positionUpdate({ ...original, qty: 0 });
      host.positionUpdate(replacement);
    };
    broker.positions = async () => {
      refreshes++;
      if (replacement) return [replacement];
      return positions();
    };
  });
  const before = refreshes;
  const result = await f.session.commands.reverse({ id: f.id, context: f.session.commands.context(f.id, 'position') });
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(result.entityIds, [f.id, 'replacement']);
  assert.equal(refreshes, before + 1);
  f.session.destroy();
});
test('C02: ambiguous replacement-ID reverse remains unconfirmed after refresh', async () => {
  let replacement;
  const f = await fixture({}, (broker, simulation, host) => {
    const positions = broker.positions;
    broker.reversePosition = async id => {
      const original = (await positions()).find(position => position.id === id);
      replacement = [1, 2].map(value => ({ ...original, id: 'replacement-' + value, side: -original.side }));
      host.positionUpdate({ ...original, qty: 0 });
      replacement.forEach(position => host.positionUpdate(position));
    };
    broker.positions = async () => replacement ?? positions();
  });
  const pending = f.session.commands.reverse({ id: f.id, context: f.session.commands.context(f.id, 'position') });
  await flush(); f.simulation.clock.advance(10000);
  assert.equal((await pending).outcome, 'unconfirmed');
  f.session.destroy();
});

test('C02/U05: amount approval validates once and a revised position cannot be partially closed', async () => {
  const f = await fixture();
  const request = () => ({ id: f.id, context: f.session.commands.context(f.id, 'position') });
  const closing = f.session.requestClose(request());
  for (let i = 0; i < 10 && !f.session.dialogs.current.get(); i++) await flush();
  const entry = f.session.dialogs.current.get(); assert.equal(entry.request.kind, 'closeAmount');
  for (const amount of [0, 5, 1.5, NaN]) assert.throws(() => f.session.dialogs.respondAmount(entry.id, amount));
  assert.equal(f.session.dialogs.current.get().id, entry.id);
  assert.equal(f.simulation.controls.calls().filter(call => call.method === 'closePosition').length, 0);
  f.session.dialogs.respondAmount(entry.id, 1); f.session.dialogs.respondAmount(entry.id, 2);
  assert.equal((await closing).outcome, 'confirmed');
  assert.equal(f.session.state.positions.get(f.id).qty, 3);
  // A provider update can change revision while approval is visible.
  f.broker.closePosition = async () => { throw new Error('Must not send a stale close'); };
  const stale = assert.rejects(f.session.requestClose(request()), { code: 'stale-context' });
  for (let i = 0; i < 10 && !f.session.dialogs.current.get(); i++) await flush();
  const staleEntry = f.session.dialogs.current.get();
  f.session.host.positionUpdate({ ...f.session.state.positions.get(f.id), qty: 2 });
  f.session.dialogs.respondAmount(staleEntry.id, 1); await stale;
  f.session.destroy();
});

test('C02/C05: selected partial amount reaches the close preview and dismissal never sends', async () => {
  const f = await fixture({ supportPreviewClosePosition: true });
  const request = () => ({ id: f.id, context: f.session.commands.context(f.id, 'position') });
  const dismissed = f.session.requestClose(request());
  for (let i = 0; i < 10 && !f.session.dialogs.current.get(); i++) await flush();
  f.session.dialogs.respond(f.session.dialogs.current.get().id, false);
  assert.equal(await dismissed, undefined);
  const closing = f.session.requestClose(request());
  for (let i = 0; i < 10 && !f.session.dialogs.current.get(); i++) await flush();
  f.session.dialogs.respondAmount(f.session.dialogs.current.get().id, 2);
  for (let i = 0; i < 10 && !f.session.dialogs.current.get(); i++) await flush();
  const preview = f.session.dialogs.current.get(); assert.equal(preview.request.kind, 'closePreview');
  const call = f.simulation.controls.calls().find(call => call.method === 'previewClosePosition');
  assert.equal(call.args[0].amount, 2);
  assert.equal(f.simulation.controls.calls().filter(call => call.method === 'closePosition').length, 0);
  f.session.dialogs.respond(preview.id, true); assert.equal((await closing).outcome, 'confirmed');
  assert.equal(f.session.state.positions.get(f.id).qty, 2); f.session.destroy();
});

test("B05/U01: symbol protection permissions cannot be bypassed for net or individual positions", async () => {
  for (const individual of [false, true]) {
    const f = await fixture({}, broker => {
      broker.getSymbolSpecificTradingOptions = async () => ({ supportModifyPositionBrackets: false });
    }, individual ? 'fx-netting' : 'equity-net');
    try {
      const id = individual ? f.session.state.individualPositions.ids()[0] : f.id;
      await assert.rejects(f.session.commands.editProtection({ id, individual,
        context: f.session.commands.context(id, individual ? 'individualPosition' : 'position'),
        brackets: { takeProfit: 110, stopLoss: 90 },
      }), { code: 'unsupported' });
      assert.equal(f.simulation.controls.calls().filter(call => /edit.*PositionBrackets/.test(call.method)).length, 0);
    } finally { f.session.destroy(); }
  }
});

test("B05/U01: locked trailing distance and allocation remain unchanged while other position protection can be edited", async () => {
  for (const multiple of [false, true]) {
    const f = await fixture();
    try {
      const initial = multiple ? { exitLevels: [
        { id: 'a', qty: 2, takeProfit: 110, trailingStopPips: 10 },
        { id: 'b', qty: 2, takeProfit: 112, stopLoss: 90 },
      ] } : { takeProfit: 110, trailingStopPips: 10 };
      const request = brackets => ({ id: f.id, context: f.session.commands.context(f.id, 'position'), brackets });
      await f.session.commands.editProtection(request(initial)); f.session.host.patchConfig({ supportModifyTrailingStop: false });
      const changed = multiple ? { exitLevels: initial.exitLevels.map(level => level.id === 'a' ? { ...level, trailingStopPips: 11 } : level) } : { ...initial, trailingStopPips: 11 };
      await assert.rejects(f.session.commands.editProtection(request(changed)), { code: 'unsupported' });
      const allowed = multiple ? { exitLevels: initial.exitLevels.map(level => level.id === 'a' ? { ...level, takeProfit: 111 } : level).reverse() } : { ...initial, takeProfit: 111 };
      assert.equal((await f.session.commands.editProtection(request(allowed))).outcome, 'confirmed');
      if (!multiple) {
        const legacy = await f.session.commands.editProtection(request({ exitLevels: [{ id: 'single', qty: 4, takeProfit: 112, trailingStopPips: 10 }] }));
        assert.equal(legacy.outcome, 'confirmed', 'equivalent single-level serialization does not modify the trailing distance');
        const payload = f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets').at(-1).args[1];
        assert.equal(payload.exitLevels, undefined); assert.equal(payload.trailingStopPips, 10);
      }
      assert.equal(f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets').length, multiple ? 2 : 3);
    } finally { f.session.destroy(); }
  }
});

test("B05/A04: reentrant loss of position or guaranteed-stop capability prevents protection dispatch", async () => {
  for (const patch of [{ supportPositionBrackets: false }, { supportGuaranteedStop: false }]) {
    const f = await fixture(); let release;
    try {
      release = f.session.pending.subscribeChanges(() => f.session.host.patchConfig(patch));
      await assert.rejects(f.session.commands.editProtection({ id: f.id, context: f.session.commands.context(f.id, 'position'),
        brackets: { takeProfit: 110, guaranteedStop: 90 },
      }), { code: 'unsupported' });
      assert.equal(f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets').length, 0);
    } finally { release?.(); f.session.destroy(); }
  }
});

test("U09: confirmed protection replacements are grouped for toasts and failed replacements keep their broker events", async () => {
  let failAfterCancellation = false;
  const f = await fixture({}, (broker, simulation, host) => {
    simulation.controls.protectionEdits("replace");
    const edit = broker.editPositionBrackets.bind(broker);
    broker.editPositionBrackets = async (...args) => {
      if (!failAfterCancellation) return edit(...args);
      const child = simulation.controls.snapshot().orders.find(order => order.status === 6);
      host.orderUpdate({ ...child, status: 1 });
      throw new Error("Replacement rejected");
    };
  });
  try {
    const edit = (takeProfit, stopLoss) => f.session.commands.editProtection({
      id: f.id,
      context: f.session.commands.context(f.id, "position"),
      brackets: { takeProfit, stopLoss },
    });
    await edit(110, 90);
    const log = () => f.session.notifications.get();
    assert.deepEqual(log().map(entry => entry.title), ["Take Profit order placed", "Stop Loss order placed"]);

    await edit(112, 88);
    const replacement = log().slice(2);
    assert.deepEqual(replacement.map(entry => entry.audience), ["history", "history", "history", "history", "toast"]);
    assert.equal(replacement.at(-1).title, "Protection updated");
    assert.match(replacement.at(-1).text, /Take Profit · Sell 4 at 112\.00\nStop Loss · Sell 4 at 88\.00/);
    assert(replacement.slice(0, -1).every(entry => entry.orderId && entry.symbol === "SIM:X"));

    failAfterCancellation = true;
    await assert.rejects(edit(114, 87), { code: "broker-rejected" });
    assert.equal(log().length, 8);
    assert.match(log().at(-1).title, /order cancelled$/);
    assert.equal(log().at(-1).audience, undefined);
  } finally {
    f.session.destroy();
  }
});

test("U09: a protection summary uses the confirmed price after an intermediate placement", async () => {
  let publishIntermediate = false;
  const f = await fixture({}, (broker, simulation, host) => {
    simulation.controls.protectionEdits("replace");
    // The broker publishes an intermediate price before the final one, whenever its updates arrive
    // relative to the editPositionBrackets promise.
    const update = host.orderUpdate.bind(host);
    host.orderUpdate = order => {
      if (publishIntermediate && order.status === OrderStatus.Working && order.limitPrice === 112)
        update({ ...order, limitPrice: 111 });
      update(order);
    };
  });
  try {
    const edit = takeProfit => f.session.commands.editProtection({
      id: f.id,
      context: f.session.commands.context(f.id, "position"),
      brackets: { takeProfit },
    });
    assert.equal((await edit(110)).outcome, "confirmed");
    publishIntermediate = true;
    assert.equal((await edit(112)).outcome, "confirmed");
    const replacement = f.session.notifications.get().slice(1);
    assert.deepEqual(replacement.map(({ title, text, audience }) => [title, text, audience]), [
      ["Take Profit order cancelled", "Sell 4 at 110.00", "history"],
      ["Take Profit order placed", "Sell 4 at 111.00", "history"],
      ["Take Profit order modified", "Sell 4 at 112.00", "history"],
      ["Take Profit order modified", "Sell 4 at 112.00", "toast"],
    ]);
  } finally {
    f.session.destroy();
  }
});
test("C05: a close rejected before dispatch keeps its review; a dispatched close consumes it", async () => {
  // The first close never answers, so it holds the position lock without changing the position in any update ordering.
  let hangNext = false;
  const f = await fixture({ supportPreviewClosePosition: true, supportPartialClosePosition: true }, (broker) => {
    const close = broker.closePosition.bind(broker);
    broker.closePosition = (...args) => {
      if (!hangNext) return close(...args);
      hangNext = false;
      return new Promise(() => {});
    };
  });
  const closes = () => f.simulation.controls.calls().filter((call) => call.method === "closePosition").length;
  const fresh = () => ({ id: f.id, context: f.session.commands.context(f.id, "position"), amount: 1 });
  const request = fresh();
  const first = await f.session.commands.previewClose(request);
  hangNext = true;
  const holding = f.session.commands.close({ ...request, previewToken: first.token, confirmId: first.preview.id });
  await flush();
  const second = await f.session.commands.previewClose(request);
  await assert.rejects(
    f.session.commands.close({ ...request, previewToken: second.token, confirmId: second.preview.id }),
    (error) => error.code === "operation-pending",
  );
  f.simulation.clock.advance(10000);
  assert.equal((await holding).outcome, "unconfirmed");
  await flush();
  // While the unconfirmed close is still being reconciled, a repeat cannot race it.
  await assert.rejects(
    f.session.commands.close({ ...request, previewToken: second.token, confirmId: second.preview.id }),
    (error) => error.code === "operation-pending",
  );
  for (let second = 0; second < 60; second++) { f.simulation.clock.advance(1000); await flush(); }
  assert.equal(f.session.pending.get(f.session.pending.ids().find(id => f.session.pending.get(id).stage === "unconfirmed")).reconciling, false);
  assert.equal(f.session.state.positions.revision(f.id), request.context.revision, "the review still describes the position");
  await f.session.commands.close({ ...request, previewToken: second.token, confirmId: second.preview.id });
  assert.equal(closes(), 1, "the kept review sends once the lock is free");
  const third = fresh(), review = await f.session.commands.previewClose(third);
  f.simulation.controls.rejectNextOperation();
  await assert.rejects(f.session.commands.close({ ...third, previewToken: review.token, confirmId: review.preview.id }), (error) => error.code === "broker-rejected");
  assert.equal(f.session.state.positions.revision(f.id), third.context.revision);
  await assert.rejects(
    f.session.commands.close({ ...third, previewToken: review.token, confirmId: review.preview.id }),
    (error) => error.code === "invalid-input",
    "a dispatched close consumed its review",
  );
  assert.equal(closes(), 2);
  f.session.destroy();
});

test("position custom fields reach the broker and require a matching broker echo for field-only edits", async () => {
  let echo, hold = false;
  const dispatched = deferred();
  const f = await fixture({}, (broker, _simulation, host) => {
    broker.getPositionDialogOptions = async () => ({ customFields: [{ id: 'source', title: 'Trigger source', inputType: 'ComboBox', value: 'last', items: [{ value: 'last', text: 'Last' }, { value: 'mark', text: 'Mark' }] }] });
    const original = broker.editPositionBrackets, readPositions = broker.positions;
    const extras = new Map();
    broker.positions = async () => (await readPositions()).map(row => ({ ...row, extra: { ...row.extra, ...extras.get(row.id) } }));
    broker.editPositionBrackets = async (id, brackets, fields) => {
      await original(id, brackets, fields);
      const position = (await broker.positions()).find(row => row.id === id);
      echo = () => { extras.set(id, fields); host.positionUpdate({ ...position, extra: { ...position.extra, ...fields } }); };
      if (!hold) echo();
      else dispatched.resolve();
    };
  });
  try {
    const request = (source) => ({ id: f.id, context: f.session.commands.context(f.id, 'position'), brackets: { takeProfit: 110, stopLoss: 90 }, customFields: { source } });
    assert.equal((await f.session.commands.editProtection(request('last'))).outcome, 'confirmed');
    const calls = f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets');
    assert.deepEqual(calls[0].args[2], { source: 'last' });
    await assert.rejects(f.session.commands.editProtection(request('random')), /valid value/);
    hold = true;
    let settled = false;
    const pending = f.session.commands.editProtection(request('mark')).then(result => { settled = true; return result; });
    await dispatched.promise; await flush(); assert.equal(settled, false);
    echo(); assert.equal((await pending).outcome, 'confirmed');
    assert.equal(f.session.state.positions.get(f.id).extra.source, 'mark');
    await assert.rejects(f.session.commands.editProtection(request('mark')), /no protection changes/);
  } finally { f.session.destroy(); }
});

test("position dialog defaults cannot confirm protection fields missing from the broker position", async () => {
  const dispatched = deferred();
  const f = await fixture({}, broker => {
    broker.getPositionDialogOptions = async () => ({ customFields: [{ id: 'source', title: 'Trigger source', inputType: 'ComboBox', value: 'last', items: [{ value: 'last', text: 'Last' }, { value: 'mark', text: 'Mark' }] }] });
    const original = broker.editPositionBrackets;
    broker.editPositionBrackets = async (...args) => { await original(...args); dispatched.resolve(); };
  });
  try {
    const pending = f.session.commands.editProtection({ id: f.id,
      context: f.session.commands.context(f.id, 'position'),
      brackets: { takeProfit: 110, stopLoss: 90 }, customFields: { source: 'last' },
    });
    await dispatched.promise; await flush(); f.simulation.clock.advance(10000);
    assert.equal((await pending).outcome, 'unconfirmed');
    assert.equal(f.session.state.positions.get(f.id).extra?.source, undefined);
  } finally { f.session.destroy(); }
});

test("removing every protection leg ignores custom fields that only configure those legs", async () => {
  const f = await fixture({}, broker => {
    broker.getPositionDialogOptions = async () => ({ customFields: [{ id: 'source', title: 'Trigger source', inputType: 'ComboBox', value: 'last', items: [{ value: 'last', text: 'Last' }, { value: 'mark', text: 'Mark' }] }] });
  });
  const request = (brackets) => ({ id: f.id, context: f.session.commands.context(f.id, 'position'), brackets, customFields: { source: 'last' } });
  const edits = () => f.simulation.controls.calls().filter(call => call.method === 'editPositionBrackets');
  try {
    await assert.rejects(f.session.commands.editProtection(request({ takeProfit: undefined, stopLoss: undefined })), /no protection changes/, "an unchanged unprotected position sends nothing");
    assert.equal(edits().length, 0);
    assert.equal((await f.session.commands.editProtection({ id: f.id, context: f.session.commands.context(f.id, 'position'), brackets: { takeProfit: 120 } })).outcome, 'confirmed');
    assert.equal((await f.session.commands.editProtection(request({ takeProfit: undefined, stopLoss: undefined }))).outcome, 'confirmed', "removal confirms without a broker echo of the trigger field");
    assert.equal(edits().at(-1).args[2], undefined);
  } finally { f.session.destroy(); }
});
