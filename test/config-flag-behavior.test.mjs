import { mapSettings, stringFormatters } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import { loadModule } from "./load-module.mjs";
import { flush } from "./manual-clock.mjs";
const { createTradingSession } = await loadModule("src/core/session.ts");
const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
const { createOverlayCoordinator } = await loadModule("src/chart/overlay-coordinator.ts");
const { ValueStore } = await loadModule("src/core/value-store.ts");

/** Server-renders Solid views so presentation-only flags have visible evidence without a browser. */
const ssrDirectory = mkdtempSync(path.join(tmpdir(), "lumen-trading-ssr-"));
process.once("exit", () => rmSync(ssrDirectory, { recursive: true, force: true }));
async function loadSsr() {
  const result = await build({
    stdin: {
      contents: [
        "export { renderToString } from 'solid-js/web';",
        "export { createComponent } from 'solid-js';",
        "export { AccountManagerView } from './src/ui/account-manager/view.tsx';",
        "export { TicketFinancialControls } from './src/ui/order-ticket/financial-controls.tsx';",
        "export { ProtectionFields } from './src/ui/protection/fields.tsx';",
        "export { OrderTicketView } from './src/ui/order-ticket/view.tsx';",
        "export { createTicketController } from './src/ui/order-ticket/controller.ts';",
        "export { createTradingSession } from './src/core/session.ts';",
        "export { createDeterministicBroker } from './src/mock/broker.ts';",
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    conditions: ["solid", "node"],
    plugins: [solidPlugin({ solid: { generate: "ssr", hydratable: false } })],
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  const filename = path.join(ssrDirectory, "ui.mjs");
  writeFileSync(filename, result.outputFiles[0].text);
  return import(pathToFileURL(filename).href);
}
const ssr = await loadSsr();

const formatters = stringFormatters;
async function fixture({ profile = "equity-net", flags = {}, configure, config, modules } = {}) {
  const { createDeterministicBroker: simulate, createTradingSession: create } =
    modules ?? { createDeterministicBroker, createTradingSession };
  const simulation = simulate({ profile }),
    factory = simulation.brokerFactory,
    settings = new Map();
  Object.assign(simulation.brokerConfig.configFlags, flags);
  config?.(simulation.brokerConfig);
  let broker;
  const session = create({
    ...simulation,
    brokerFactory: (host) => {
      broker = factory(host);
      configure?.(broker, simulation, host);
      return broker;
    },
    settings: mapSettings(settings),
    formatters,
  });
  await session.ready;
  return { simulation, session, broker, calls: (method) => simulation.controls.calls().filter((call) => call.method === method) };
}
const positionContext = (session, id, individual = false) =>
  session.commands.context(id, individual ? "individualPosition" : "position");
function chartCollection() {
  const charts = [];
  return {
    charts,
    collection: { charts: () => charts, activeChart: () => charts[0], subscribe: () => () => {} },
    add(id) {
      const overlays = [];
      charts.push({
        binding: new ValueStore({ id, generation: 1, symbol: "SIM:X" }),
        registerContextActions: () => () => {},
        onTradeIntent: () => () => {},
        symbolContext: async () => ({}),
        createOverlay(spec) {
          const overlay = { spec, update(patch) { for (const [key, value] of Object.entries(patch)) if (value !== undefined) overlay.spec = { ...overlay.spec, [key]: value }; }, subscribe: () => () => {}, cancelInteraction() {}, remove() {} };
          overlays.push(overlay);
          return overlay;
        },
      });
      return overlays;
    },
  };
}
async function positionOverlayActions(session) {
  const charts = chartCollection(), overlays = charts.add("A");
  const coordinator = createOverlayCoordinator(session, charts.collection, () => {});
  await flush();
  const overlay = overlays.find((value) => value.spec.kind === "position");
  coordinator.destroy();
  return overlay?.spec.actions ?? [];
}

test("U01: supportCloseIndividualPosition dispatches closeIndividualPosition, rejects when false and needs the broker method", async () => {
  const enabled = await fixture({ profile: "fx-netting" });
  const id = enabled.session.state.individualPositions.ids()[0];
  const result = await enabled.session.commands.close({ id, individual: true, context: positionContext(enabled.session, id, true) });
  assert.equal(result.outcome, "confirmed");
  assert.equal(enabled.calls("closeIndividualPosition").length, 1);
  enabled.session.destroy();

  const disabled = await fixture({ profile: "fx-netting", flags: { supportCloseIndividualPosition: false } });
  const other = disabled.session.state.individualPositions.ids()[0];
  await assert.rejects(
    disabled.session.commands.close({ id: other, individual: true, context: positionContext(disabled.session, other, true) }),
    (error) => error.code === "unsupported",
  );
  assert.equal(disabled.calls("closeIndividualPosition").length, 0);
  disabled.session.destroy();

  const missing = await fixture({ profile: "fx-netting", configure: (broker) => { delete broker.closeIndividualPosition; } });
  assert.equal(missing.session.policy.get().flags.supportCloseIndividualPosition, false);
  assert(missing.session.policy.get().diagnostics.some((item) => item.capability === "supportCloseIndividualPosition" && item.missing.includes("closeIndividualPosition")));
  missing.session.destroy();
});

test("U01: supportPartialClosePosition and supportPartialCloseIndividualPosition gate partial amounts while full closes still dispatch", async () => {
  for (const individual of [false, true]) {
    const flag = individual ? "supportPartialCloseIndividualPosition" : "supportPartialClosePosition";
    const method = individual ? "closeIndividualPosition" : "closePosition";
    const profile = individual ? "fx-netting" : "equity-net";
    const store = (session) => (individual ? session.state.individualPositions : session.state.positions);

    const blocked = await fixture({ profile, flags: { [flag]: false } });
    const id = store(blocked.session).ids()[0];
    await assert.rejects(
      blocked.session.commands.close({ id, individual, amount: 1, context: positionContext(blocked.session, id, individual) }),
      (error) => error.code === "unsupported" && /Partial/.test(error.message),
      flag,
    );
    assert.equal(blocked.calls(method).length, 0, flag);
    assert.equal((await blocked.session.commands.close({ id, individual, context: positionContext(blocked.session, id, individual) })).outcome, "confirmed");
    assert.equal(blocked.calls(method).at(-1).args[1], 4, `${flag} full close sends the whole quantity`);
    blocked.session.destroy();

    const allowed = await fixture({ profile, flags: { [flag]: true } });
    const partialId = store(allowed.session).ids()[0];
    assert.equal((await allowed.session.commands.close({ id: partialId, individual, amount: 1, context: positionContext(allowed.session, partialId, individual) })).outcome, "confirmed");
    assert.equal(allowed.calls(method).at(-1).args[1], 1, flag);
    assert.equal(store(allowed.session).get(partialId).qty, 3, flag);
    allowed.session.destroy();
  }
});

test("U01: supportReversePosition hides the chart reverse action and rejects the reverse command when false", async () => {
  const enabled = await fixture({ flags: { supportReversePosition: true } });
  assert((await positionOverlayActions(enabled.session)).includes("reverse"));
  const id = enabled.session.state.positions.ids()[0];
  assert.equal((await enabled.session.commands.reverse({ id, context: positionContext(enabled.session, id) })).outcome, "confirmed");
  assert.equal(enabled.calls("reversePosition").length, 1);
  enabled.session.destroy();

  const disabled = await fixture({ flags: { supportReversePosition: false } });
  const actions = await positionOverlayActions(disabled.session);
  assert(actions.includes("close"));
  assert(!actions.includes("reverse"));
  const other = disabled.session.state.positions.ids()[0];
  await assert.rejects(disabled.session.commands.reverse({ id: other, context: positionContext(disabled.session, other) }), (error) => error.code === "unsupported");
  assert.equal(disabled.calls("reversePosition").length + disabled.calls("placeOrder").length, 0);
  disabled.session.destroy();
});

test("U01: SymbolSpecificTradingOptions supportReversePosition overrides the config per symbol and otherwise defaults to the config", async () => {
  const symbolOptions = (value) => (broker) => {
    broker.getSymbolSpecificTradingOptions = async () => (value === undefined ? {} : { supportReversePosition: value });
  };
  const forbidden = await fixture({ flags: { supportReversePosition: true }, configure: symbolOptions(false) });
  await forbidden.session.symbolInfo("SIM:X");
  assert.equal(forbidden.session.symbolPolicy("SIM:X").flags.supportReversePosition, false);
  const id = forbidden.session.state.positions.ids()[0];
  await assert.rejects(forbidden.session.commands.reverse({ id, context: positionContext(forbidden.session, id) }), (error) => error.code === "unsupported");
  assert.equal(forbidden.calls("reversePosition").length, 0);
  forbidden.session.destroy();

  const permitted = await fixture({ flags: { supportReversePosition: false }, configure: symbolOptions(true) });
  await permitted.session.symbolInfo("SIM:X");
  const other = permitted.session.state.positions.ids()[0];
  assert.equal((await permitted.session.commands.reverse({ id: other, context: positionContext(permitted.session, other) })).outcome, "confirmed");
  permitted.session.destroy();

  for (const configured of [true, false]) {
    const inherited = await fixture({ flags: { supportReversePosition: configured }, configure: symbolOptions(undefined) });
    await inherited.session.symbolInfo("SIM:X");
    assert.equal(inherited.session.symbolPolicy("SIM:X").flags.supportReversePosition, configured);
    inherited.session.destroy();
  }
});

test("U01: SymbolSpecificTradingOptions supportReversePosition false is enforced before the symbol's options were ever loaded", async () => {
  const forbidden = await fixture({ flags: { supportReversePosition: true, supportNativeReversePosition: true }, configure: (broker) => {
    broker.getSymbolSpecificTradingOptions = async () => ({ supportReversePosition: false });
  } });
  const id = forbidden.session.state.positions.ids()[0];
  await assert.rejects(forbidden.session.commands.reverse({ id, context: positionContext(forbidden.session, id) }), (error) => error.code === "unsupported");
  assert.equal(forbidden.calls("reversePosition").length, 0);
  forbidden.session.destroy();
});

test("U01: supportMultiposition disables the default (fallback) reversal so only native reversing can reverse a position", async () => {
  const multi = await fixture({ profile: "fx-multiposition", flags: { supportNativeReversePosition: false } });
  assert.equal(multi.session.policy.get().flags.supportMultiposition, true);
  const id = multi.session.state.positions.ids()[0];
  await assert.rejects(multi.session.commands.reverse({ id, context: positionContext(multi.session, id) }), (error) => error.code === "unsupported" && /native/.test(error.message));
  assert.equal(multi.calls("placeOrder").length + multi.calls("reversePosition").length, 0);
  multi.session.destroy();

  const native = await fixture({ profile: "fx-multiposition" });
  const nativeId = native.session.state.positions.ids()[0];
  assert.equal((await native.session.commands.reverse({ id: nativeId, context: positionContext(native.session, nativeId) })).outcome, "confirmed");
  assert.equal(native.calls("reversePosition").length, 1);
  native.session.destroy();

  const net = await fixture({
    flags: { supportMultiposition: false, supportNativeReversePosition: false },
    configure: (broker, simulation) => {
      const place = broker.placeOrder;
      broker.placeOrder = async (order) => { const result = await place(order); simulation.controls.fill(result.orderId); return result; };
    },
  });
  const netId = net.session.state.positions.ids()[0];
  await net.session.commands.reverse({ id: netId, context: positionContext(net.session, netId) });
  const [fallback] = net.calls("placeOrder");
  assert.equal(fallback.args[0].qty, 8, "default reversal sends twice the position quantity");
  assert.equal(fallback.args[0].type, 2, "as a market order");
  assert.equal(fallback.args[0].isClose, true);
  net.session.destroy();
});

test("U01: supportMarketOrders, supportLimitOrders and supportStopOrders select Order Ticket types and reject disabled types before dispatch", async () => {
  const cases = [
    ["supportMarketOrders", 2, {}],
    ["supportLimitOrders", 1, { limitPrice: 99 }],
    ["supportStopOrders", 3, { stopPrice: 101 }],
  ];
  const ticketTypes = async (session) => {
    const controller = ssr.createTicketController(session);
    await controller.open({ id: "chart", generation: 1, symbol: "SIM:X" }, {});
    const html = ssr.renderToString(() => ssr.createComponent(ssr.OrderTicketView, { active: true, session, controller }));
    const tabs = html.match(/aria-label="Order type"[\s\S]*?<\/div>/)[0];
    return [...tabs.matchAll(/role="tab"[^>]*data-key="(\d+)"/g)].map((match) => Number(match[1]));
  };
  const defaults = await fixture({ modules: ssr });
  assert.deepEqual(await ticketTypes(defaults.session), [2, 1, 3, 4]);
  assert.deepEqual([2, 1, 3].map((type) => defaults.session.policy.get().orderTypes.includes(type)), [true, true, true], "all three default to true");
  defaults.session.destroy();
  for (const [flag, type, prices] of cases) {
    const f = await fixture({ modules: ssr, flags: { [flag]: false } });
    assert(!f.session.policy.get().orderTypes.includes(type), flag);
    assert.equal(f.session.policy.get().orderTypes.length, 3, `${flag} leaves the other types`);
    assert.deepEqual(await ticketTypes(f.session), [2, 1, 3, 4].filter((value) => value !== type), `${flag} Order Ticket tabs`);
    await assert.rejects(
      f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", side: 1, qty: 2, type, ...prices } }),
      (error) => error.code === "unsupported",
      flag,
    );
    assert.equal(f.calls("placeOrder").length, 0, flag);
    f.session.destroy();
  }
});

test("U01: supportStopLimitOrdersInBothDirections skips the stop-limit stop price direction check only when enabled", async () => {
  for (const both of [false, true]) {
    const f = await fixture({ flags: { supportStopLimitOrders: true, supportStopLimitOrdersInBothDirections: both } });
    const release = f.session.acquireQuotes("SIM:X", "fast", () => {});
    await flush();
    assert.equal(f.session.state.quotes.get("SIM:X").ask, 100.01);
    // A buy stop below the ask is on the wrong side unless the order behaves like Limit-if-Touched.
    const placing = f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", side: 1, qty: 2, type: 4, stopPrice: 99, limitPrice: 99 } });
    if (both) {
      assert.equal((await placing).outcome, "confirmed");
      assert.equal(f.calls("placeOrder").length, 1);
    } else {
      await assert.rejects(placing, /wrong side/);
      assert.equal(f.calls("placeOrder").length, 0);
    }
    release();
    f.session.destroy();
  }
});

const accountManagerTabs = (session) => {
  const html = ssr.renderToString(() =>
    ssr.createComponent(ssr.AccountManagerView, {
      session, environment: {}, collapsed: false, maximized: false, canTrade: true,
      onClose() {}, onToggle() {}, onMaximize() {}, onTrade() {},
    }),
  );
  return [...html.matchAll(/role="tab"[^>]*data-key="([^"]+)"/g)].map((match) => match[1]);
};
const finalOrders = [
  { id: "H1", symbol: "SIM:X", side: 1, type: 1, qty: 2, limitPrice: 99, status: 2 },
  { id: "H2", symbol: "SIM:X", side: -1, type: 1, qty: 1, limitPrice: 101, status: 1 },
  { id: "H3", symbol: "SIM:X", side: 1, type: 2, qty: 3, status: 5 },
];

test("A01/U01: supportOrdersHistory reads ordersHistory into the History tab, and when false neither calls ordersHistory nor shows the tab", async () => {
  let reads = 0;
  const enabled = await fixture({ modules: ssr, flags: { supportOrdersHistory: true }, configure: (broker) => { broker.ordersHistory = async () => { reads++; return finalOrders; }; } });
  assert.equal(reads, 1);
  assert.deepEqual([...enabled.session.state.history.ids()].sort(), ["H1", "H2", "H3"]);
  assert.deepEqual(finalOrders.map((order) => enabled.session.state.history.get(order.id).status), [2, 1, 5]);
  assert(accountManagerTabs(enabled.session).includes("history"));
  enabled.session.destroy();

  reads = 0;
  const disabled = await fixture({ modules: ssr, flags: { supportOrdersHistory: false }, configure: (broker) => { broker.ordersHistory = async () => { reads++; return finalOrders; }; } });
  assert.equal(reads, 0);
  assert.equal(disabled.session.state.history.ids().length, 0);
  assert(!accountManagerTabs(disabled.session).includes("history"));
  disabled.session.destroy();
});

test("A01: ordersHistory is required while supportOrdersHistory is enabled; a missing method is diagnosed and the Account Manager still works", async () => {
  const missing = await fixture({ modules: ssr, configure: (broker) => { delete broker.ordersHistory; } });
  const policy = missing.session.policy.get();
  assert.equal(policy.flags.supportOrdersHistory, false);
  assert(policy.diagnostics.some((item) => item.capability === "supportOrdersHistory" && item.missing.includes("ordersHistory")));
  assert.equal(missing.session.state.connection.get().phase, "ready");
  const tabs = accountManagerTabs(missing.session);
  assert(tabs.includes("orders") && !tabs.includes("history"));
  missing.session.destroy();
});

test("U01: showNotificationsLog shows the Notifications log tab by default and hides it when false", async () => {
  const shown = await fixture({ modules: ssr });
  assert.equal(shown.session.policy.get().flags.showNotificationsLog, true);
  assert(accountManagerTabs(shown.session).includes("notifications"));
  shown.session.destroy();
  const hidden = await fixture({ modules: ssr, flags: { showNotificationsLog: false } });
  const tabs = accountManagerTabs(hidden.session);
  assert(tabs.includes("orders") && !tabs.includes("notifications"));
  hidden.session.destroy();
});

test("U01: supportBalances shows cryptoBalanceUpdate balances in the crypto Order Ticket only when enabled", async () => {
  for (const enabled of [true, false]) {
    const f = await fixture({ modules: ssr, profile: "crypto", flags: { supportBalances: enabled } });
    f.session.host.cryptoBalanceUpdate("SIM", { symbol: "SIM", total: 5, available: 3.5 });
    f.session.host.cryptoBalanceUpdate("USD", { symbol: "USD", total: 900, available: 750 });
    const controller = ssr.createTicketController(f.session);
    await controller.open({ id: "chart", generation: 1, symbol: "SIM:X" }, { type: 1, limitPrice: 100 });
    const html = ssr.renderToString(() => ssr.createComponent(ssr.TicketFinancialControls, { active: true, session: f.session, controller, quote: () => ({}) }));
    assert.match(html, /Quote currency amount/, "crypto ticket is active");
    if (enabled) {
      assert.match(html, /SIM available<\/dt><dd>3\.5/);
      assert.match(html, /USD available<\/dt><dd>750/);
    } else assert.doesNotMatch(html, /available<\/dt>/);
    controller.destroy?.();
    f.session.destroy();
  }
});

test("X08: customNotificationFields makes a broker change to a listed custom order field raise a notification", async () => {
  for (const fields of [["additionalType"], undefined]) {
    const f = await fixture({ config: (config) => { if (fields) config.customNotificationFields = fields; } });
    const working = { id: "N", symbol: "SIM:X", side: 1, type: 1, qty: 2, limitPrice: 99, status: 6 };
    f.session.host.orderUpdate({ ...working, extra: { additionalType: "plain" } });
    f.session.host.orderUpdate({ ...working, extra: { additionalType: "oco" } });
    f.session.host.orderUpdate({ ...working, extra: { additionalType: "oco", untracked: 1 } });
    const titles = f.session.notifications.get().map((item) => item.title);
    assert.deepEqual(titles, fields ? ["Limit order placed", "Limit order modified"] : ["Limit order placed"]);
    f.session.destroy();
  }
});

test("X08: durations drive the time-in-force choices per order type, apply the default and reject unlisted durations", async () => {
  const f = await fixture({
    config: (config) => {
      config.durations = [
        { name: "Day", value: "DAY", default: true },
        { name: "Good until date", value: "GTD", hasDatePicker: true, supportedOrderTypes: [1] },
        { name: "Immediate or cancel", value: "IOC", supportedOrderTypes: [2] },
      ];
    },
  });
  const { durationsForType } = await loadModule("src/core/capabilities.ts");
  const policy = f.session.policy.get();
  assert.deepEqual(durationsForType(policy, 1).map((item) => item.value), ["DAY", "GTD"]);
  assert.deepEqual(durationsForType(policy, 2).map((item) => item.value), ["IOC"]);
  assert.deepEqual(durationsForType(policy, 3).map((item) => item.value), ["DAY"]);
  const place = (order) => f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", side: 1, qty: 2, ...order } });
  await place({ type: 1, limitPrice: 99 });
  assert.equal(f.calls("placeOrder").at(-1).args[0].duration.type, "DAY", "the default duration is applied");
  await assert.rejects(place({ type: 1, limitPrice: 99, duration: { type: "GTC" } }), (error) => error.code === "unsupported");
  await assert.rejects(place({ type: 1, limitPrice: 99, duration: { type: "IOC" } }), (error) => error.code === "unsupported");
  await assert.rejects(place({ type: 1, limitPrice: 99, duration: { type: "GTD", datetime: 1 } }), /future/);
  assert.equal(f.calls("placeOrder").length, 1);
  f.session.destroy();

  const none = await fixture({ config: (config) => { delete config.durations; } });
  assert.equal(none.session.policy.get().durations.length, 0);
  await none.session.commands.place({ context: none.session.commands.context(), order: { symbol: "SIM:X", side: 1, qty: 2, type: 1, limitPrice: 99 } });
  assert.equal(none.calls("placeOrder").at(-1).args[0].duration, undefined, "no durations means no time-in-force menu or value");
  none.session.destroy();
});

test("X08: orderRules has no documented behavior and is carried without affecting validation or dispatch", async () => {
  const rules = [{ id: "O", severity: "error" }, { id: "P", severity: "warning" }];
  const f = await fixture({ config: (config) => { config.orderRules = rules; } });
  const result = await f.session.commands.place({ context: f.session.commands.context(), order: { symbol: "SIM:X", side: 1, qty: 2, type: 1, limitPrice: 99 } });
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.calls("placeOrder").length, 1);
  assert.deepEqual(rules, [{ id: "O", severity: "error" }, { id: "P", severity: "warning" }], "the caller's rules are not mutated");
  f.session.destroy();
});

test("U05/X08: customUI showOrderDialog, showPositionDialog, showCancelOrderDialog and showClosePositionDialog replace the built-in dialogs", async () => {
  const seen = [];
  const f = await fixture({
    config: (config) => {
      config.customUI = {
        showOrderDialog: async (order) => { seen.push(["order", order.symbol]); return true; },
        showPositionDialog: async (position, brackets) => { seen.push(["position", position.id, brackets.stopLoss]); return false; },
        showCancelOrderDialog: async (order) => { seen.push(["cancel", order.id]); return true; },
        showClosePositionDialog: async (position) => { seen.push(["close", position.id]); return true; },
      };
    },
  });
  const { session, host } = { session: f.session, host: f.session.host };
  assert.equal(await session.showOrderTicket({ id: "chart", generation: 1, symbol: "SIM:X" }, { symbol: "SIM:X", side: 1, qty: 2 }), true);
  assert.equal(await host.showOrderDialog({ symbol: "SIM:X", side: -1, qty: 1 }), true);
  const position = session.state.positions.get(session.state.positions.ids()[0]);
  assert.equal(await host.showPositionBracketsDialog(position, { stopLoss: 90 }), false);
  host.orderUpdate({ id: "C", symbol: "SIM:X", side: 1, type: 1, qty: 2, limitPrice: 99, status: 6 });
  let handled = 0;
  await host.showCancelOrderDialog("C", async () => { handled++; });
  assert.equal(handled, 1);
  const closed = await session.requestClose({ id: position.id, context: positionContext(session, position.id) });
  assert.equal(closed.outcome, "confirmed");
  assert.equal(f.calls("closePosition").length, 1);
  assert.deepEqual(seen, [["order", "SIM:X"], ["order", "SIM:X"], ["position", position.id, 90], ["cancel", "C"], ["close", position.id]]);
  assert.equal(session.dialogs.current.get(), undefined, "no built-in dialog was queued");
  f.session.destroy();
});

test("U01: SymbolSpecificTradingOptions supportBracketsInPips defaults to true and false removes the pips/ticks protection unit", async () => {
  const render = async (options) => {
    const f = await fixture({ modules: ssr, configure: (broker) => { broker.getSymbolSpecificTradingOptions = async () => options; } });
    const instrument = await f.session.symbolInfo("SIM:X");
    const policy = f.session.symbolPolicy("SIM:X");
    const html = ssr.renderToString(() =>
      ssr.createComponent(ssr.ProtectionFields, {
        active: true, session: f.session, policy, symbol: "SIM:X", side: 1, quantity: 2,
        brackets: { takeProfit: 101, stopLoss: 99 }, instrument, entry: 100, disabled: false,
        modifying: false, stopMoneyAllowed: true, price: String, update() {},
      }),
    );
    f.session.destroy();
    return { policy, html };
  };
  const swap = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="Switch ${label} units"[^>]*>`))[0];
  const defaulted = await render({});
  assert.equal(defaulted.policy.symbol.supportBracketsInPips, true);
  assert.doesNotMatch(swap(defaulted.html, "take profit"), /disabled/);
  const forbidden = await render({ supportBracketsInPips: false });
  assert.equal(forbidden.policy.symbol.supportBracketsInPips, false);
  // Render the settled alternative immediately; effects do not run during server rendering.
  for (const label of ["take profit", "stop loss"]) {
    assert.match(forbidden.html, new RegExp(`aria-label="Paired ${label} display"[^>]*data-value="percentage"`));
    assert.doesNotMatch(swap(forbidden.html, label), /disabled/);
  }
});

test("U01/B03: closePositionCancelsOrders warns in the close confirmation only when the position has working brackets, and dispatch stays a plain close", async () => {
  for (const flag of [true, false]) {
    const f = await fixture({ flags: { closePositionCancelsOrders: flag, supportPartialClosePosition: false, supportPreviewClosePosition: false } });
    const id = f.session.state.positions.ids()[0];
    const position = f.session.state.positions.get(id);
    f.session.host.orderUpdate({ id: `tp-${flag}`, symbol: position.symbol, side: position.side === 1 ? -1 : 1, type: 1, qty: position.qty, limitPrice: 150, status: 6, parentId: id, parentType: 2 });
    let shown;
    const pending = f.session.requestClose({ id, context: positionContext(f.session, id) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = f.session.dialogs.current.get();
    shown = entry.request.content;
    f.session.dialogs.respond(entry.id, true);
    await pending;
    assert.equal(shown.includes("Its take-profit and stop-loss orders will also be cancelled."), flag, `flag ${flag}`);
    assert.equal(f.calls("closePosition").length, 1);
    f.session.destroy();
  }
});

test("P01/U01: positionPLInInstrumentCurrency estimates money as price difference × quantity × point value (bigPointValue or lotSize, over priceMagnifier) instead of account-currency pip values", async () => {
  const { positionProfit } = await loadModule("src/core/financial-rules.ts");
  const input = { position: { side: 1, qty: 2, avgPrice: 100 }, instrument: { pipSize: 0.01, minTick: 0.01, pipValue: 5, lotSize: 10, qty: { min: 1, max: 10, step: 1 } }, quotes: { bid: 101, ask: 101.02 }, mode: "money", supportPLUpdate: false, source: "chart" };
  assert.equal(positionProfit({ ...input, inInstrumentCurrency: true }), 20);
  assert.equal(positionProfit({ ...input, inInstrumentCurrency: false }), 1000);
  const future = { ...input.instrument, lotSize: undefined, bigPointValue: 50, priceMagnifier: 10 };
  assert.equal(positionProfit({ ...input, instrument: future, inInstrumentCurrency: true }), 10, "bigPointValue and priceMagnifier apply as in notional");
});

test("U01/X08: supportCustomOrderInfo is accepted and retained but adds nothing to Order info, because the pinned API defines no way to supply custom order info", async () => {
  const f = await fixture({ flags: { supportCustomOrderInfo: true } });
  assert.equal(f.session.policy.get().flags.supportCustomOrderInfo, true);
  assert.equal(f.session.policy.get().diagnostics.some((d) => d.capability === "supportCustomOrderInfo"), false);
  f.session.destroy();
});
