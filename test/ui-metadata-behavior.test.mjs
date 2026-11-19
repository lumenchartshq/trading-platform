import { ManualClock } from "./manual-clock.mjs";
import { mapSettings } from './support/session-fixture.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import { loadModule } from "./load-module.mjs";

/*
 * Broker metadata that only changes what the mounted Solid UI shows (Account Manager columns,
 * menu actions, custom ticket fields, previews) is exercised through the real `mountTradingPlatform`
 * against the deterministic broker. JSDOM is only a test fixture.
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { JSDOM } = createRequire(import.meta.url)("jsdom");

const directory = mkdtempSync(path.join(tmpdir(), "lumen-trading-ui-tests-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
async function loadUi() {
  const result = await build({
    stdin: {
      contents: [
        `export { mountTradingPlatform } from "./src/ui/mount.tsx";`,
        `export { normalizeMenuItems } from "./src/ui/account-manager/context-menu.tsx";`,
        `export { createTradingSession } from "./src/core/session.ts";`,
        `export { createDeterministicBroker } from "./src/mock/broker.ts";`,
        `export { ValueStore } from "./src/core/value-store.ts";`,
        `export { delegateEvents } from "solid-js/web";`,
      ].join("\n"),
      resolveDir: packageRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    alias: {
      "solid-js": "solid-js/dist/solid.js",
      "solid-js/web": "solid-js/web/dist/web.js",
      "solid-js/store": "solid-js/store/dist/store.js",
    },
    plugins: [solidPlugin()],
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const filename = path.join(
    directory,
    `ui-${createHash("sha256").update(code).digest("hex").slice(0, 16)}.mjs`,
  );
  writeFileSync(filename, code);
  return import(pathToFileURL(filename).href);
}
// Authored JSX registers delegated events at module evaluation, so the bundle loads under a bootstrap window.
const bootstrap = new JSDOM("<!doctype html><html><body></body></html>");
for (const [key, value] of [["window", bootstrap.window], ["document", bootstrap.window.document]])
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const ui = await loadUi();
delete globalThis.window;
delete globalThis.document;
const { normalizeTradability } = await loadModule("src/core/tradability.ts");

const globalKeys = [
  "window", "HTMLSelectElement", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement",
  "HTMLHeadElement", "HTMLBodyElement", "Element", "SVGElement", "Node", "Document", "Event", "MouseEvent", "KeyboardEvent",
  "FocusEvent", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle",
  "NodeFilter", "MutationObserver", "CustomEvent", "ResizeObserver",
];
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test" });
  const setStyleProperty = dom.window.CSSStyleDeclaration.prototype.setProperty;
  dom.window.CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
    if (String(value) === "calc(NaN%)") return;
    return setStyleProperty.call(this, property, value, priority);
  };
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  // JSDOM has no layout; give the ticket's virtual viewport its real geometry.
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true, get() { return this.hasAttribute("data-logical-count") ? 240 : 0; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true, get() { return this.hasAttribute("data-logical-count") ? 320 : 0; },
  });
  dom.window.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = handle => clearTimeout(handle);
  const previous = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  for (const key of globalKeys) if (key in dom.window) set(key, dom.window[key]);
  set("window", dom.window);
  set("document", dom.window.document);
  set("navigator", dom.window.navigator);
  set("requestAnimationFrame", (callback) => setTimeout(() => callback(Date.now()), 0));
  set("cancelAnimationFrame", (handle) => clearTimeout(handle));
  set("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  ui.delegateEvents(
    ["input", "change", "click", "keydown", "keyup", "pointerdown", "pointerup", "pointercancel", "focusin", "focusout", "contextmenu"],
    dom.window.document,
  );
  // A real mouse click fires pointerdown/pointerup first; Kobalte tabs and menu items act on those.
  const click = dom.window.HTMLElement.prototype.click;
  dom.window.HTMLElement.prototype.click = function () {
    if (/^(tab|menuitem|menuitemcheckbox|option)$/.test(this.getAttribute("role") ?? "") && !this.disabled) {
      const pointer = (type) => Object.assign(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }), { pointerType: "mouse", pointerId: 1 });
      this.dispatchEvent(pointer("pointerdown"));
      this.dispatchEvent(pointer("pointerup"));
    }
    return click.call(this);
  };
  return () => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}
async function flush(times = 2) {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
const formatters = {
  defaultPrice: async () => ({ format: String }),
  numeric: async (places) => ({ format: (value) => Number(value).toFixed(places) }),
  quantity: async () => ({ format: String }),
  createPriceFormatter: () => ({ format: String }),
};
/** Mount the real platform UI over a deterministic broker; `configureBroker` customizes broker metadata. */
async function mounted(options = {}) {
  const restore = installDom();
  const simulation = ui.createDeterministicBroker({ profile: options.profile ?? "equity-net" });
  Object.assign(simulation.brokerConfig.configFlags, options.brokerFlags);
  options.configureSimulation?.(simulation);
  const settings = new Map();
  const session = ui.createTradingSession({
    ...simulation,
    ...(options.clock ? { clock: options.clock } : {}),
    brokerFactory: (host) => {
      const broker = simulation.brokerFactory(host);
      options.configureBroker?.(broker, host);
      return broker;
    },
    extensions: { ...simulation.extensions, ...options.extensions },
    ...(options.enabledFeatures ? { enabledFeatures: options.enabledFeatures } : {}),
    ...(options.disabledFeatures ? { disabledFeatures: options.disabledFeatures } : {}),
    settings: mapSettings(settings),
    formatters,
  });
  await session.ready;
  const binding = new ui.ValueStore({ id: "C", generation: 1, symbol: "SIM:X" });
  const chart = {
    binding,
    symbolContext: async () => ({ symbol: "SIM:X", minTick: 0.01, priceScale: 100, minMove: 1, resolved: true, tradable: true, hasBars: true }),
    onTradeIntent: () => () => {},
    registerContextActions: () => () => {},
    requestSymbol: (symbol) => options.requestedSymbols?.push(symbol),
    createOverlay: () => ({ update() {}, cancelInteraction() {}, remove() {}, subscribe: () => () => {} }),
  };
  const surfaces = new Map();
  const presentation = {
    environment: new ui.ValueStore({ locale: "en", timezone: "UTC", theme: "light", width: 1440, height: 900 }),
    settings: mapSettings(settings),
    acquireSurface(kind) {
      const element = document.createElement("div");
      document.body.append(element);
      surfaces.set(kind, element);
      return { element, release: () => { element.remove(); surfaces.delete(kind); } };
    },
    setDockSize(...args) { options.dockSizes?.push(args); },
    notifyLayoutChanged() {},
    ...(options.searchSymbols ? { searchSymbols: options.searchSymbols } : {}),
  };
  const platform = ui.mountTradingPlatform({
    session,
    presentation,
    collection: { charts: () => [chart], activeChart: () => chart, subscribe: () => () => {} },
  });
  await platform.ready;
  await flush();
  return {
    session,
    simulation,
    chart,
    surfaces,
    calls: (method) => simulation.controls.calls().filter((call) => call.method === method),
    destroy() {
      platform.destroy();
      session.destroy();
      restore();
    },
  };
}
const button = (root, label) =>
  [...root.querySelectorAll("button")].find((element) =>
    element.getAttribute("aria-label")?.startsWith(label) || element.textContent.trim().startsWith(label));
const inputField = (root, label) =>
  [...root.querySelectorAll("input")].find((element) => element.getAttribute("aria-label") === label) ??
  [...root.querySelectorAll("label")].find((element) => element.querySelector("span")?.textContent === label)?.querySelector("input");
const inputValue = (input, value) => {
  assert(input);
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const selectValue = (element) => (element.tagName === "SELECT" ? element.value : element.dataset.value);
/** Pick an option on a Kobalte select trigger (keyboard open, then the option by key). */
async function pickOption(element, value) {
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await flush();
  const listbox = document.getElementById(element.getAttribute("aria-controls"));
  const option = listbox?.querySelector(`[data-key="${value}"]`);
  assert(option, `option ${value} is offered`);
  const pointer = (type) => Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }), { pointerType: "mouse", pointerId: 1 });
  option.dispatchEvent(pointer("pointerdown"));
  option.dispatchEvent(pointer("pointerup"));
  option.click();
  await flush();
}
/** Read a Kobalte select's option labels (opened briefly, then dismissed). */
async function optionLabels(trigger) {
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await flush();
  const listbox = document.getElementById(trigger.getAttribute("aria-controls"));
  const labels = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].map((option) => ({ value: option.dataset.key, label: (option.querySelector("[data-option-label], span, div") ?? option).textContent.trim() }));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  return labels;
}
const submit = async (form) => {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
};
/** Open the mounted order ticket for SIM:X and return its surface. */
async function openTicket(f, template = { side: 1, type: 1, limitPrice: 100 }) {
  void f.session.showOrderTicket(f.chart.binding.get(), { symbol: "SIM:X", ...template }).catch(() => {});
  await flush(3);
  return f.surfaces.get("ticket");
}
const order = (fields) => ({ symbol: "SIM:X", type: 1, side: 1, qty: 2, limitPrice: 100, status: 6, ...fields });

const rowIds = (root) => [...root.querySelectorAll("tbody tr[data-row-id]")].map((row) => row.dataset.rowId);
const header = (root, label) => [...root.querySelectorAll("thead th")].find((cell) => cell.textContent.startsWith(label));
const withAccountInfo = (patch) => ({
  configureBroker(broker, host) {
    const base = broker.accountManagerInfo.bind(broker);
    broker.accountManagerInfo = () => ({ ...base(), ...patch(host) });
  },
});

test("U06: accountTitle names the panel; column help, alignment, sortProp and notSortable drive headers, cells and sorting", async () => {
  const f = await mounted(withAccountInfo(() => ({
    accountTitle: "Acme Brokerage",
    orderColumns: [
      { id: "symbol", label: "Symbol", dataFields: ["symbol"], help: "Instrument traded" },
      { id: "qty", label: "Quantity", dataFields: ["qty"], alignment: "right", sortProp: "limitPrice" },
      { id: "status", label: "Status", dataFields: ["status"], notSortable: true },
      { id: "whole", label: "Whole row", dataFields: [] },
    ],
  })));
  try {
    for (const row of [order({ id: "A", qty: 1, limitPrice: 200 }), order({ id: "B", qty: 2, limitPrice: 300 }), order({ id: "C", qty: 3, limitPrice: 100 })])
      f.session.host.orderUpdate(row);
    await flush();
    const accounts = f.surfaces.get("accounts");
    assert.equal(accounts.querySelector("header.trading-panel-header strong").textContent, "Acme Brokerage", "accountTitle replaces the default panel name");
    button(accounts, "Orders").click();
    await flush();
    assert.equal(header(accounts, "Symbol").title, "Instrument traded", "help is the column tooltip");
    assert.equal(header(accounts, "Quantity").title, "", "columns without help have no tooltip");
    const cells = accounts.querySelector('tr[data-row-id="A"]').querySelectorAll("td");
    assert.equal(cells[0].style.textAlign, "left", "alignment defaults to left");
    assert.equal(cells[1].style.textAlign, "right", "alignment right is applied to the cell");
    assert.deepEqual(rowIds(accounts), ["A", "B", "C"]);
    const quantity = header(accounts, "Quantity").querySelector("button");
    quantity.click();
    await flush();
    assert.deepEqual(rowIds(accounts), ["C", "A", "B"], "sortProp limitPrice orders the Quantity column, not qty");
    assert.equal(header(accounts, "Quantity").getAttribute("aria-sort"), "ascending");
    quantity.click();
    await flush();
    assert.deepEqual(rowIds(accounts), ["B", "A", "C"], "a second click reverses the sortProp order");
    const status = header(accounts, "Status").querySelector("button");
    assert.equal(status.disabled, true, "notSortable disables the header control");
    status.click();
    await flush();
    assert.deepEqual(rowIds(accounts), ["B", "A", "C"], "notSortable never changes the order");
    assert.equal(header(accounts, "Whole row").querySelector("button").disabled, true, "empty dataFields without sortProp cannot sort");
  } finally { f.destroy(); }
});

test("U06: historyColumns and historyColumnsSorting (SortingParameters asc false) shape the History page; asc defaults to true for orders", async () => {
  const history = [
    order({ id: "H1", qty: 1, status: 2, limitPrice: 10 }),
    order({ id: "H3", qty: 3, status: 2, limitPrice: 30 }),
    order({ id: "H2", qty: 2, status: 1, limitPrice: 20 }),
  ];
  const f = await mounted({
    brokerFlags: { supportOrdersHistory: true },
    configureBroker(broker) {
      const base = broker.accountManagerInfo.bind(broker);
      broker.ordersHistory = async () => structuredClone(history);
      broker.accountManagerInfo = () => ({
        ...base(),
        orderColumnsSorting: { property: "qty" },
        historyColumns: [
          { id: "symbol", label: "Symbol", dataFields: ["symbol"] },
          { id: "filled", label: "Filled quantity", dataFields: ["qty"] },
        ],
        historyColumnsSorting: { property: "qty", asc: false },
      });
    },
  });
  try {
    for (const row of [order({ id: "W2", qty: 2 }), order({ id: "W1", qty: 1 })]) f.session.host.orderUpdate(row);
    await flush();
    const accounts = f.surfaces.get("accounts");
    button(accounts, "Orders").click();
    await flush();
    assert.deepEqual(rowIds(accounts), ["W1", "W2"], "SortingParameters without asc sort ascending");
    assert(!header(accounts, "Filled quantity"), "historyColumns are not used for working orders");
    button(accounts, "History").click();
    await flush(3);
    assert.deepEqual([...accounts.querySelectorAll("thead th[aria-sort]")].map((cell) => cell.textContent), ["Symbol", "Filled quantity"], "historyColumns define the History page");
    assert.deepEqual(rowIds(accounts), ["H3", "H2", "H1"], "historyColumnsSorting asc false sorts the History page descending");
    assert.equal(header(accounts, "Filled quantity").getAttribute("aria-sort"), "descending");
  } finally { f.destroy(); }
});

test("U07: AccountManagerTable initialSorting orders a custom page table until the user sorts a column", async () => {
  const f = await mounted(withAccountInfo((host) => ({
    pages: [{
      id: "cash",
      title: "Balances",
      tables: [{
        id: "balances",
        columns: [
          { id: "name", label: "Name", dataFields: ["name"] },
          { id: "amount", label: "Amount", dataFields: ["amount"] },
        ],
        changeDelegate: host.factory.createDelegate(),
        initialSorting: { property: "amount", asc: false },
        getData: async () => [
          { id: "a", name: "Alpha", amount: 1 },
          { id: "b", name: "Bravo", amount: 3 },
          { id: "c", name: "Charlie", amount: 2 },
        ],
      }],
    }],
  })));
  try {
    const accounts = f.surfaces.get("accounts");
    button(accounts, "Balances").click();
    await flush(3);
    const table = accounts.querySelector('section[aria-label="balances"]');
    assert.deepEqual(rowIds(table), ["b", "c", "a"], "initialSorting sorts by amount descending");
    header(table, "Name").querySelector("button").click();
    await flush();
    assert.deepEqual(rowIds(table), ["a", "b", "c"], "a user-selected column replaces initialSorting");
  } finally { f.destroy(); }
});

test("X08: ActionDescription shortcut, tooltip, checkable, checked, checkedStateSource and enabled shape row menu items", async () => {
  const ran = [];
  let source = true;
  const f = await mounted(withAccountInfo(() => ({
    contextMenuActions: async () => [
      { text: "Open chart", shortcut: "Alt+C", tooltip: "Show this symbol", action: () => ran.push("chart") },
      { text: "Show fills", checkable: true, checked: true, action: (description) => ran.push(["fills", description.checked]) },
      { text: "Follow price", checkable: true, checked: false, checkedStateSource: () => source, action: () => ran.push("follow") },
      { text: "Archive", enabled: false, action: () => ran.push("archive") },
    ],
  })));
  try {
    f.session.host.orderUpdate(order({ id: "menu-row" }));
    await flush();
    const accounts = f.surfaces.get("accounts");
    button(accounts, "Orders").click();
    await flush();
    const open = async () => {
      accounts.querySelector('[data-row-id="menu-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
      await flush();
      return f.surfaces.get("dialogs").querySelector('[role="menu"][aria-label="Row actions"]');
    };
    let menu = await open();
    const item = (text) => [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].find((element) => element.textContent.includes(text));
    assert.equal(item("Open chart").querySelector("kbd").textContent, "Alt+C", "shortcut is shown as hint text");
    assert.equal(item("Open chart").title, "Show this symbol", "tooltip is the item's hover text");
    assert.equal(item("Show fills").getAttribute("role"), "menuitemcheckbox", "checkable renders a checkbox item");
    assert.equal(item("Show fills").getAttribute("aria-checked"), "true", "checked is the checkbox value");
    assert.equal(item("Open chart").getAttribute("role"), "menuitem", "items are plain actions unless checkable");
    assert.equal(item("Follow price").getAttribute("aria-checked"), "true", "checkedStateSource overrides the static checked value");
    assert.equal(item("Archive").getAttribute("aria-disabled"), "true", "enabled false disables the item");
    item("Archive").click();
    await flush();
    assert.deepEqual(ran, [], "a disabled action never runs");
    item("Show fills").click();
    await flush();
    assert.deepEqual(ran, [["fills", true]], "the checkable action receives its description");
    source = false;
    menu = await open();
    assert.equal(item("Follow price").getAttribute("aria-checked"), "false", "checkedStateSource is read again when the menu opens");
  } finally { f.destroy(); }
});

test("U04: OrderPreviewSection header and rows, OrderPreviewResult errors and HyperlinkInfo text/url render in the review; errors block sending", async () => {
  let blocked = true;
  const f = await mounted({
    brokerFlags: { supportPlaceOrderPreview: true },
    configureBroker(broker) {
      const base = broker.previewOrder.bind(broker);
      broker.previewOrder = async (value) => ({
        ...(await base(value)),
        sections: [
          { header: "Costs", rows: [{ title: "Commission", value: "1.00 USD" }] },
          { rows: [{ title: "Margin", value: "50.00 USD" }] },
        ],
        warnings: [["Read the ", { text: "risk notice", url: "https://example.test/risk" }, " and ", { text: "unsafe link", url: "javascript:alert(1)" }]],
        ...(blocked ? { errors: ["Insufficient buying power"] } : {}),
      });
    },
  });
  try {
    const ticket = await openTicket(f);
    await submit(ticket.querySelector("form"));
    const review = ticket.querySelector(".trading-confirmation");
    assert(review, ticket.textContent);
    const sections = [...review.querySelectorAll("section")];
    assert.deepEqual(sections.map((section) => section.querySelector("h4")?.textContent ?? null), ["Costs", null], "header titles only the section that has one");
    assert.deepEqual(sections.map((section) => [...section.querySelectorAll("dt, dd")].map((cell) => cell.textContent)), [["Commission", "1.00 USD"], ["Margin", "50.00 USD"]], "each section row is a title/value pair");
    const warning = review.querySelector(".trading-warning");
    const link = warning.querySelector("a");
    assert.equal(link.textContent, "risk notice", "HyperlinkInfo text is the link label");
    assert.equal(link.getAttribute("href"), "https://example.test/risk", "HyperlinkInfo url is the link target");
    assert.equal(link.target, "_blank");
    assert.match(link.rel, /noopener/);
    assert.equal(warning.querySelectorAll("a").length, 1, "a non-http HyperlinkInfo url stays plain text");
    assert.match(warning.textContent, /Read the risk notice and unsafe link/);
    assert.equal(review.querySelector('[role="alert"]').textContent, "Insufficient buying power", "errors are shown as alerts");
    assert.equal(button(review, "Send order").disabled, true, "errors block sending");
    button(review, "Send order").click();
    await flush();
    assert.equal(f.calls("placeOrder").length, 0);
    blocked = false;
    button(review, "Edit order").click();
    await flush();
    await submit(ticket.querySelector("form"));
    const clean = ticket.querySelector(".trading-confirmation");
    assert.equal(clean.querySelector('[role="alert"]'), null);
    button(clean, "Send order").click();
    await flush(3);
    assert.equal(f.calls("placeOrder").length, 1, "a preview without errors can be sent once");
  } finally { f.destroy(); }
});

test("U02: OrderDurationMetaInfo default selects the opening duration and hasTimePicker adds the expiration time only for that duration", async () => {
  const f = await mounted({
    configureSimulation(simulation) {
      simulation.brokerConfig.durations = [
        { name: "Good until cancelled", value: "GTC" },
        { name: "Day", value: "DAY", default: true },
        { name: "Good until date", value: "GTD", hasDatePicker: true },
        { name: "Good until time", value: "GTT", hasDatePicker: true, hasTimePicker: true },
      ];
    },
  });
  try {
    const ticket = await openTicket(f);
    const select = ticket.querySelector('[aria-label="Time in force"]');
    assert.equal(selectValue(select), "DAY", "the default duration is selected when the ticket opens");
    assert.equal(inputField(ticket, "Expiration date"), undefined);
    await pickOption(select, "GTD");
    assert(inputField(ticket, "Expiration date"), "a date-only duration shows its date");
    assert.equal(inputField(ticket, "Expiration time"), undefined, "without hasTimePicker there is no time control");
    assert.match(ticket.textContent, /expires at midnight/);
    await pickOption(select, "GTT");
    assert.equal(inputField(ticket, "Expiration time")?.type, "time", "hasTimePicker shows the time control");
  } finally { f.destroy(); }
});

test("P03: QuantityMetainfo default seeds a new ticket quantity and uiStep sets the quantity input step", async () => {
  const f = await mounted({
    configureBroker(broker) {
      const base = broker.symbolInfo.bind(broker);
      broker.symbolInfo = async (symbol) => ({ ...(await base(symbol)), qty: { min: 1, max: 1000, step: 1, uiStep: 5, default: 7 } });
    },
  });
  try {
    const ticket = await openTicket(f);
    const quantity = [...ticket.querySelectorAll('input[type="number"]')].find((input) => input.max === "1000");
    assert(quantity, "the units input carries the instrument bounds");
    assert.equal(quantity.value, "7", "default is the quantity of a new ticket");
    assert.equal(quantity.step, "5", "uiStep is the input step instead of step");
  } finally { f.destroy(); }
});

test("U03/X08: CustomComboBoxMetaInfo items (CustomComboBoxItem text), preventModify, TextWithCheckboxFieldMetaInfo customInfo checkboxTitle and TextWithCheckboxValue text/checked reach the ticket and order", async () => {
  const f = await mounted({
    configureBroker(broker) {
      broker.getOrderDialogOptions = async () => ({
        customFields: [
          { id: "route", title: "Route", inputType: "ComboBox", value: "smart", items: [{ text: "Smart routing", value: "smart" }, { text: "Direct", value: "direct" }] },
          { id: "desk", title: "Desk note", inputType: "TextField", value: "fixed", preventModify: true },
          { id: "sig", title: "Signature", inputType: "TextWithCheckBox", value: { text: "", checked: false }, customInfo: { checkboxTitle: "Remember signature" } },
        ],
      });
    },
  });
  try {
    const ticket = await openTicket(f);
    const route = ticket.querySelector('[aria-label="Route"]');
    assert.deepEqual(await optionLabels(route), [{ value: "smart", label: "Smart routing" }, { value: "direct", label: "Direct" }], "combo box items are offered by their text");
    await pickOption(route, "direct");
    const desk = inputField(ticket, "Desk note");
    assert.equal(desk.value, "fixed");
    assert.equal(desk.disabled, true, "preventModify locks the field");
    const signature = [...ticket.querySelectorAll(".trading-field")].find((label) => label.querySelector("span")?.textContent === "Signature");
    assert.match(signature.querySelector(".trading-check").textContent, /Remember signature/, "customInfo checkboxTitle labels the checkbox");
    assert.equal(signature.tagName, "DIV", "two controls are not nested in one label");
    assert.equal(signature.querySelector(".trading-check").tagName, "LABEL", "the checkbox has its own label");
    assert.equal(document.getElementById(signature.querySelector('input[type="text"]').getAttribute("aria-labelledby"))?.textContent, "Signature");
    inputValue(signature.querySelector('input[type="text"]'), "J. Doe");
    const check = signature.querySelector('input[type="checkbox"]');
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await submit(ticket.querySelector("form"));
    const send = button(ticket, "Send order");
    if (send) { send.click(); await flush(3); }
    const placed = f.calls("placeOrder");
    assert.equal(placed.length, 1, ticket.textContent);
    assert.deepEqual(placed[0].args[0].customFields, { route: "direct", desk: "fixed", sig: { text: "J. Doe", checked: true } }, "TextWithCheckboxValue carries text and checked");
  } finally { f.destroy(); }
});

test("U03/P03: ClosePositionPreviewResult rows (ClosePositionPreviewRowData currency, ClosePositionPreviewSeparator type separator) and disclaimer render before closing once", async () => {
  const f = await mounted({
    brokerFlags: { supportPreviewClosePosition: true, supportPartialClosePosition: false },
    // The broker issues the preview ID; the rows and disclaimer are this test's presentation.
    configureSimulation(simulation) {
      const issue = simulation.extensions.previewClosePosition;
      simulation.extensions.previewClosePosition = async (request) => ({
        ...(await issue(request)),
        rows: [
          { title: "Quantity", value: "2" },
          { type: "separator" },
          { title: "Estimated P&L", value: "12.50", currency: "USD" },
        ],
        disclaimer: ["Prices may move. See ", { text: "execution policy", url: "https://example.test/policy" }],
      });
    },
  });
  try {
    const id = f.session.state.positions.ids()[0];
    assert(id, "the profile has an open position");
    const closing = f.session.requestClose({ id, context: f.session.commands.context(id, "position") });
    await flush(3);
    const dialog = f.surfaces.get("dialogs");
    const list = dialog.querySelector("dl");
    assert(list, dialog.textContent);
    assert.deepEqual([...list.children].map((child) => child.tagName), ["DIV", "HR", "DIV"], "a separator row becomes a divider");
    assert.deepEqual([...list.querySelectorAll("dt, dd")].map((cell) => cell.textContent.trim()), ["Quantity", "2", "Estimated P&L", "12.50 USD"], "rows show title, value and currency");
    const link = dialog.querySelector("p a");
    assert.equal(link.textContent, "execution policy", "the disclaimer renders as markup text");
    assert.match(dialog.textContent, /Prices may move/);
    button(dialog, "Close position").click();
    assert.equal((await closing).outcome, "confirmed");
    assert.equal(f.calls("closePosition").length, 1);
  } finally { f.destroy(); }
});

test("P04: ticket leverage sends LeverageInfoParams orderType and side to leverageInfo and shows LeveragePreviewResult warnings without blocking", async () => {
  const f = await mounted({
    configureBroker(broker) {
      broker.previewLeverage = async () => ({ warnings: ["High leverage increases your risk."] });
    },
  });
  try {
    const ticket = await openTicket(f, { side: -1, type: 1, limitPrice: 100 });
    button(ticket, "1:10").click();
    await flush(3);
    const info = f.calls("leverageInfo").at(-1).args[0];
    assert.equal(info.side, -1, "side is the ticket side");
    assert.equal(info.orderType, 1, "orderType is the ticket order type");
    const dialog = f.surfaces.get("dialogs");
    inputValue(inputField(dialog, "Leverage"), 20);
    await submit(dialog.querySelector("form"));
    const review = dialog.querySelector('[aria-label="Leverage review"]');
    assert.equal(review.querySelector('[data-tone="warning"]').textContent, "High leverage increases your risk.", "warnings are shown in the review");
    assert.equal(review.querySelector('[role="alert"]'), null);
    button(dialog, "Apply leverage").click();
    await flush(3);
    assert.equal(f.calls("setLeverage").length, 1, "warnings do not block applying");
    const applied = f.calls("setLeverage")[0].args[0];
    assert.deepEqual([applied.symbol, applied.orderType, applied.side, applied.leverage], ["SIM:X", 1, -1, 20]);
  } finally { f.destroy(); }
});

test("X08: TradableSolutionsTypes changeAccountSolution, changeSymbolSolution and openUrlSolution (OpenUrlSolution openUrl url/text) drive the ticket's solution button", async () => {
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { changeAccount: "simulation-B" } }).solution, { kind: "account", accountId: "simulation-B" });
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { changeSymbol: "SIM:Y" } }).solution, { kind: "symbol", symbol: "SIM:Y" });
  assert.deepEqual(normalizeTradability({ tradable: false, solutions: { openUrl: { url: "https://example.test/kyc", text: "Verify identity" } } }).solution, { kind: "url", url: "https://example.test/kyc", text: "Verify identity" });
  assert.equal(normalizeTradability({ tradable: false, solutions: { openUrl: { url: "javascript:alert(1)", text: "Run" } } }).solution, undefined, "only http(s) openUrl links are offered");
  const solve = async (solutions, label, check) => {
    const requestedSymbols = [];
    const f = await mounted({ requestedSymbols, configureBroker(broker) { broker.isTradable = async () => ({ tradable: false, reason: "Not available here.", solutions }); } });
    try {
      const opened = [];
      window.open = (...args) => { opened.push(args); return null; };
      const ticket = await openTicket(f);
      const notice = ticket.querySelector('[data-ui="untradable"]');
      assert(notice, ticket.textContent);
      const action = button(notice, label);
      assert(action, `${label} is offered: ${notice.textContent}`);
      action.click();
      await flush(3);
      check({ f, opened, requestedSymbols });
    } finally { f.destroy(); }
  };
  await solve({ changeAccount: "simulation-B" }, "Change account", ({ f }) => {
    assert.deepEqual(f.calls("setCurrentAccount").map((call) => call.args[0]), ["simulation-B"], "changeAccount switches to the suggested account");
  });
  await solve({ changeSymbol: "SIM:Y" }, "Show SIM:Y", ({ requestedSymbols }) => {
    assert.deepEqual(requestedSymbols, ["SIM:Y"], "changeSymbol shows the suggested symbol");
  });
  await solve({ openUrl: { url: "https://example.test/kyc", text: "Verify identity" } }, "Verify identity", ({ opened }) => {
    assert.deepEqual(opened, [["https://example.test/kyc", "_blank", "noopener,noreferrer"]], "openUrl text labels the button and url opens in a new tab");
  });
});

test("U03: CustomInputFieldMetaInfo customInfo stays attached to the ticket field for the broker while the validator is held back", async () => {
  const { createTicketController } = await loadModule("src/ui/order-ticket/controller.ts");
  const { createTradingSession } = await loadModule("src/core/session.ts");
  const { createDeterministicBroker } = await loadModule("src/mock/broker.ts");
  const simulation = createDeterministicBroker(), settings = new Map();
  const customInfo = { source: "desk", codes: [1, 2] };
  const session = createTradingSession({
    ...simulation,
    brokerFactory: (host) => {
      const broker = simulation.brokerFactory(host);
      broker.getOrderDialogOptions = async () => ({
        customFields: [{ id: "desk", title: "Desk", inputType: "TextField", value: "A", customInfo, validator: (value) => (value ? { valid: true } : { valid: false, errorMessage: "Required" }) }],
      });
      return broker;
    },
    settings: mapSettings(settings),
    formatters,
  });
  await session.ready;
  const controller = createTicketController(session);
  try {
    await controller.open({ id: "chart", generation: 1, symbol: "SIM:X" }, { type: 1, limitPrice: 100 });
    const [field] = controller.state.get().options.customFields;
    assert.deepEqual(field.customInfo, customInfo, "customInfo reaches the ticket unchanged");
    assert.equal("validator" in field, false, "callbacks are not copied into ticket state");
    assert.equal(controller.state.get().order.customFields.desk, "A");
  } finally { controller.destroy(); session.destroy(); }
});


test("U03: CheckboxFieldMetaInfo help describes the checkbox, CheckboxFieldMetaInfo supportModify keeps it editable while modifying, and TextWithCheckboxFieldCustomInfo asterix masks the text", async () => {
  const fields = [
    { id: "ack", title: "Acknowledge risk", inputType: "Checkbox", value: false, help: "Required for leveraged products" },
    { id: "notify", title: "Notify me", inputType: "Checkbox", value: false, supportModify: true },
    { id: "pin", title: "PIN", inputType: "TextWithCheckBox", value: { text: "", checked: false }, customInfo: { checkboxTitle: "Remember", asterix: true } },
  ];
  const withFields = (seed) => mounted({
    configureBroker(broker, host) {
      broker.getOrderDialogOptions = async () => ({ customFields: fields });
      if (seed) queueMicrotask(() => host.orderUpdate(order({ id: "M1" })));
    },
  });
  const field = (root, title) => [...root.querySelectorAll(".trading-field")].find((label) => label.querySelector("span")?.textContent === title);
  let f = await withFields(false);
  try {
    const ticket = await openTicket(f);
    const ack = field(ticket, "Acknowledge risk").querySelector('input[type="checkbox"]');
    assert.equal(document.getElementById(ack.getAttribute("aria-describedby"))?.textContent, "Required for leveraged products");
    assert.equal(ack.disabled, false, "new orders may set any checkbox");
    assert.equal(field(ticket, "PIN").querySelector("input:not([type=checkbox])").type, "password");
  } finally { f.destroy(); }
  f = await withFields(true);
  try {
    await flush();
    const ticket = await openTicket(f, f.session.state.orders.get("M1"));
    assert.match(ticket.textContent, /Modify order/);
    assert.equal(field(ticket, "Acknowledge risk").querySelector('input[type="checkbox"]').disabled, true, "no supportModify: locked while modifying");
    assert.equal(field(ticket, "Notify me").querySelector('input[type="checkbox"]').disabled, false, "supportModify: editable while modifying");
  } finally { f.destroy(); }
});

test("U01/U06: supportDemoLiveSwitcher shows Demo/Live only for brokers with both account types; switching type changes to that type's account and filters the picker", async () => {
  const typed = [{ id: "D1", name: "Paper", type: "demo", currency: "USD" }, { id: "L1", name: "Cash", type: "live", currency: "USD" }, { id: "L2", name: "Margin", type: "live", currency: "USD" }];
  for (const enabled of [true, false]) {
    const f = await mounted({
      brokerFlags: { supportDemoLiveSwitcher: enabled },
      configureBroker(broker, host) {
        let current = "D1";
        broker.accountsMetainfo = async () => typed;
        broker.currentAccount = () => current;
        broker.setCurrentAccount = (id) => { current = id; host.currentAccountUpdate(); };
      },
    });
    try {
      f.session.host.setAccountManagerVisibilityMode?.(0);
      await flush(3);
      const accounts = f.surfaces.get("accounts");
      const group = accounts.querySelector('[role="group"][aria-label="Account type"]');
      if (!enabled) { assert.equal(group, null, "flag false hides the switcher"); continue; }
      assert(group, accounts.innerHTML.slice(0, 400));
      const buttons = [...group.querySelectorAll("button")];
      assert.deepEqual(buttons.map((b) => b.textContent.trim()), ["Demo", "Live"]);
      assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
      assert.deepEqual(await optionLabels(accounts.querySelector('[aria-label="Trading account"]')), [{ value: "D1", label: "Paper" }]);
      buttons[1].click();
      for (let i = 0; i < 6; i++) await flush();
      assert.equal(f.session.state.connection.get().accountId, "L1", "Live selects the first live account");
      assert.equal(group.querySelectorAll("button")[1].getAttribute("aria-pressed"), "true");
      assert.deepEqual((await optionLabels(accounts.querySelector('[aria-label="Trading account"]'))).map((o) => o.value), ["L1", "L2"]);
    } finally { f.destroy(); }
  }
});

test("U01/U03: supportSymbolSearch adds ticket symbol search through the host datafeed; choosing a result reopens the ticket for that symbol", async () => {
  const clock = new ManualClock();
  for (const enabled of [true, false]) {
    const queries = [];
    const f = await mounted({
      clock,
      brokerFlags: { supportSymbolSearch: enabled },
      configureBroker(broker) {
        const original = broker.symbolInfo.bind(broker);
        broker.symbolInfo = async (symbol) => (symbol === "SIM:Y" ? { ...(await original("SIM:X")), brokerSymbol: "SIM:Y", description: "Second instrument" } : original(symbol));
        const tradable = broker.isTradable.bind(broker);
        broker.isTradable = async (symbol) => (symbol === "SIM:Y" ? true : tradable(symbol));
      },
      searchSymbols: async (query) => { queries.push(query); return [{ symbol: "SIM:Y", description: "Second instrument" }]; },
    });
    try {
      const ticket = await openTicket(f);
      const input = ticket.querySelector('input[aria-label="Search symbol"]');
      if (!enabled) { assert.equal(input, null, "flag false: no search"); continue; }
      assert(input);
      inputValue(input, "si");
      clock.advance(199);
      await flush(2);
      assert.deepEqual(queries, []);
      clock.advance(1);
      await flush(2);
      assert.deepEqual(queries, ["si"]);
      const result = button(ticket, "SIM:Y");
      assert(result, ticket.innerHTML.slice(0, 300));
      assert.match(result.textContent, /Second instrument/);
      result.click();
      for (let i = 0; i < 6; i++) await flush();
      const current = f.surfaces.get("ticket");
      assert.equal(f.session.state.connection.get().phase, "ready");
      assert.match(current.querySelector('[data-ui="trading-ticket"]').textContent, /Buy2 Y\b/);
      assert.equal(current.querySelector(".trading-symbol-results"), null, "results close after choosing");
    } finally { f.destroy(); }
  }
});

test("X01: order_panel false removes the Account Manager Trade button and keeps show_order_panel_on_start from opening a ticket", async () => {
  for (const orderPanel of [true, false]) {
    const f = await mounted({
      enabledFeatures: ["show_order_panel_on_start"],
      ...(orderPanel ? {} : { disabledFeatures: ["order_panel"] }),
    });
    try {
      await flush(3);
      const trade = f.surfaces.get("accounts")?.querySelector(".trading-account-trade");
      assert.equal(!!trade, orderPanel, `Trade button with order_panel=${orderPanel}`);
      assert.equal(f.session.host.orderPanelVisibility().value(), orderPanel, "show_order_panel_on_start opens a ticket only with order_panel");
    } finally { f.destroy(); }
  }
});

test("U09: orderPanelVisibility and domPanelVisibility mirror the ticket and depth panel, and broker writes open or close them", async () => {
  const f = await mounted({ brokerFlags: { supportLevel2Data: true }, enabledFeatures: ["dom_widget"] });
  try {
    const order = f.session.host.orderPanelVisibility(), depth = f.session.host.domPanelVisibility();
    assert.equal(order.value(), false);
    await openTicket(f);
    assert.equal(order.value(), true, "opening the ticket reports it visible");
    order.setValue(false);
    await flush(3);
    assert.equal(f.session.dialogs.current.get(), undefined, "a broker write closes the ticket");
    assert.equal(order.value(), false);
    order.setValue(true);
    await flush(4);
    assert.equal(f.session.dialogs.current.get()?.request.kind, "order", "a broker write opens the ticket on the active chart");
    assert.equal(f.session.policy.get().dom, true, "the depth panel is available in this fixture");
    {
      depth.setValue(true);
      await flush(4);
      assert.equal(depth.value(), true);
      assert(f.surfaces.get("dom"), "a broker write opens the depth panel");
      depth.setValue(false);
      await flush(2);
      assert.equal(f.surfaces.get("dom").hidden, true);
    }
  } finally { f.destroy(); }
});

test("U09: a broker write to orderPanelVisibility or domPanelVisibility that cannot open its panel settles back to false, so later writes still apply", async () => {
  const f = await mounted({ disabledFeatures: ["order_panel", "dom_widget"] });
  try {
    const order = f.session.host.orderPanelVisibility(), depth = f.session.host.domPanelVisibility();
    order.setValue(true);
    depth.setValue(true);
    await flush(4);
    assert.equal(order.value(), false, "order_panel disabled: the ticket stays closed and the value says so");
    assert.equal(depth.value(), false, "dom_widget disabled: no depth panel and the value says so");
    assert.equal(f.session.dialogs.current.get(), undefined);
  } finally { f.destroy(); }
});

test("U09: position protection reports the order panel open without opening a new order ticket", async () => {
  const f = await mounted();
  try {
    const visibility = f.session.host.orderPanelVisibility();
    const changes = [];
    visibility.subscribe(value => changes.push(value));
    const position = f.session.state.positions.get(f.session.state.positions.ids()[0]);
    const result = f.session.host.showPositionBracketsDialog(position, {});
    await flush(4);
    assert.equal(f.session.dialogs.current.get()?.request.kind, "position");
    assert.equal(visibility.value(), true, "a mobile host must reveal the chart for position protection too");
    assert.deepEqual(changes, [true]);
    visibility.setValue(false);
    assert.equal(await result, false, "closing the order panel dismisses position protection");
    await flush(4);
    assert.equal(f.session.dialogs.current.get(), undefined, "no spurious new-order request is queued");
    assert.deepEqual(changes, [true, false]);
    await openTicket(f);
    f.session.dialogs.respond(f.session.dialogs.current.get().id, true);
    await flush();
    changes.length = 0;
    const next = f.session.host.showPositionBracketsDialog(position, {});
    await flush();
    assert.deepEqual(changes, [true], "a new protection pane reveals the chart even if a ticket was already open");
    f.session.dialogs.respond(f.session.dialogs.current.get().id, false);
    assert.equal(await next, false);
  } finally { f.destroy(); }
});

test("U01/U03: supportSymbolSearch never chooses a previous query's result: typing clears results and Enter searches the current text", async () => {
  const clock = new ManualClock();
  const f = await mounted({
    clock,
    brokerFlags: { supportSymbolSearch: true },
    configureBroker(broker) {
      const original = broker.symbolInfo.bind(broker), tradable = broker.isTradable.bind(broker);
      broker.symbolInfo = async (symbol) => (symbol.startsWith("SIM:") && symbol !== "SIM:X" ? { ...(await original("SIM:X")), brokerSymbol: symbol } : original(symbol));
      broker.isTradable = async (symbol) => (symbol.startsWith("SIM:") ? true : tradable(symbol));
    },
    searchSymbols: async (query) => [{ symbol: query === "a" ? "SIM:A" : "SIM:B" }],
  });
  try {
    const ticket = await openTicket(f);
    const input = ticket.querySelector('input[aria-label="Search symbol"]');
    inputValue(input, "a");
    clock.advance(200);
    await flush(2);
    assert(button(ticket, "SIM:A"));
    inputValue(input, "b");
    assert.equal(button(ticket, "SIM:A"), undefined, "typing drops the previous query's results");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let i = 0; i < 8; i++) await flush();
    assert.match(f.surfaces.get("ticket").querySelector('[data-ui="trading-ticket"]').textContent, /Buy2 B\b/);
  } finally { f.destroy(); }
});

test("U01/U06: SymbolSpecificTradingOptions supportReversePosition true offers Reverse on the Account Manager row even when the account flag is off", async () => {
  const f = await mounted({
    brokerFlags: { supportReversePosition: false, supportNativeReversePosition: true },
    configureBroker(broker) { broker.getSymbolSpecificTradingOptions = async () => ({ supportReversePosition: true }); },
  });
  try {
    f.session.host.setAccountManagerVisibilityMode?.(0);
    await f.session.symbolInfo("SIM:X");
    const accounts = f.surfaces.get("accounts");
    const positionsTab = [...accounts.querySelectorAll('[role="tab"]')].find((tab) => /^Positions/.test(tab.textContent));
    positionsTab.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    positionsTab.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    positionsTab.click();
    for (let i = 0; i < 4; i++) await flush();
    const row = accounts.querySelector("tbody tr[data-row-id]");
    assert(row, accounts.textContent.slice(0, 200));
    assert(button(row, "Reverse"), row.textContent);
  } finally { f.destroy(); }
});

test("U09/X09: chart quote buttons repaint once per frame for a burst of quotes", async () => {
  const f = await mounted();
  try {
    const controls = f.surfaces.get("chart-controls");
    const sell = controls && [...controls.querySelectorAll("button")].find((element) => element.textContent.includes("Sell"));
    assert(sell, "the chart quote buttons are mounted");
    let repaints = 0;
    const observer = new MutationObserver((records) => { repaints += records.length; });
    observer.observe(sell, { subtree: true, characterData: true, childList: true });
    for (let tick = 0; tick < 50; tick++) f.simulation.controls.quote("SIM:X", 101 + tick / 100);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(repaints, 0, "no repaint before the frame");
    await flush();
    observer.disconnect();
    assert(repaints > 0 && repaints <= 2, `one repaint for the burst (got ${repaints} mutation records)`);
    assert.match(sell.textContent, /101\.4[89]/, "the frame shows the latest quote");
  } finally { f.destroy(); }
});

test("U09/X09: the ticket dock is resized when the ticket opens and closes, not on every ticket change", async () => {
  const dockSizes = [];
  const f = await mounted({ dockSizes });
  try {
    const ticket = await openTicket(f);
    const opened = dockSizes.filter(([kind]) => kind === "ticket").length;
    assert(opened >= 1, "opening reserves the dock");
    const quantity = inputField(ticket, "Quantity") ?? ticket.querySelector('[data-ui="order-quantity-input"]');
    for (const qty of [3, 4, 5]) { inputValue(quantity, qty); await flush(); }
    assert.equal(dockSizes.filter(([kind]) => kind === "ticket").length, opened, "editing the open ticket does not resize the dock");
  } finally { f.destroy(); }
});

test("U07/X09: tab-counter page controllers rebuild only when a hydration hands over new metadata", async () => {
  let reads = 0, info;
  const f = await mounted({
    configureBroker(broker, host) {
      const base = broker.accountManagerInfo.bind(broker);
      broker.accountManagerInfo = () => {
        info ??= { ...base(), pages: [{
          id: "counted",
          title: "Counted",
          displayCounterInTab: true,
          tables: [{
            id: "counted-table",
            columns: [{ id: "name", label: "Name", dataFields: ["name"] }],
            changeDelegate: host.factory.createDelegate(),
            getData: async () => { reads++; return [{ id: "a", name: "Alpha" }]; },
          }],
        }] };
        return info;
      };
    },
  });
  try {
    await flush(3);
    const initial = reads;
    assert(initial >= 1, "the counter page loads eagerly");
    await f.session.refresh();
    await flush(3);
    assert.equal(reads, initial, "a hydration that hands over the same metadata object does not recreate the controllers");
    info = undefined;
    f.simulation.controls.disconnect(); await flush();
    f.simulation.controls.reconnect(); await flush(4);
    assert(reads > initial, "a reconnect that hands over new metadata reloads the counter");
  } finally { f.destroy(); }
});

test("U07/A02: tab counters follow the metadata of the current connection, not the previous one", async () => {
  let generation = 0;
  const f = await mounted({
    configureBroker(broker, host) {
      const base = broker.accountManagerInfo.bind(broker);
      broker.accountManagerInfo = () => ({ ...base(), pages: [{
        id: `page-${generation}`,
        title: `Page ${generation}`,
        displayCounterInTab: true,
        tables: [{
          id: "table",
          columns: [{ id: "name", label: "Name", dataFields: ["name"] }],
          changeDelegate: host.factory.createDelegate(),
          getData: async () => Array.from({ length: generation + 1 }, (_, index) => ({ id: `r${index}`, name: "Row" })),
        }],
      }] });
    },
  });
  try {
    await flush(3);
    const accounts = f.surfaces.get("accounts");
    assert(button(accounts, "Page 0"), "the first connection's page is shown");
    generation = 1;
    f.simulation.controls.disconnect(); await flush();
    f.simulation.controls.reconnect(); await flush(4);
    const tab = button(accounts, "Page 1");
    assert(tab, "the reconnect's page replaces the previous one");
    assert.match(tab.textContent, /2/, "its counter comes from the new connection's table, not the previous metadata");
  } finally { f.destroy(); }
});

test("U06/X09: an order update re-renders only its own Account Manager row", async () => {
  const f = await mounted();
  try {
    f.session.host.orderUpdate(order({ id: "row-a" }));
    f.session.host.orderUpdate(order({ id: "row-b" }));
    await flush();
    const accounts = f.surfaces.get("accounts");
    button(accounts, "Orders").click();
    await flush();
    const rowA = accounts.querySelector('[data-row-id="row-a"]'), rowB = accounts.querySelector('[data-row-id="row-b"]');
    assert(rowA && rowB);
    const changes = new Map([[rowA, 0], [rowB, 0]]);
    const observers = [rowA, rowB].map((row) => {
      const observer = new MutationObserver((records) => changes.set(row, changes.get(row) + records.length));
      observer.observe(row, { subtree: true, characterData: true, childList: true });
      return observer;
    });
    f.session.host.orderUpdate(order({ id: "row-a", qty: 7 }));
    await flush();
    for (const observer of observers) observer.disconnect();
    assert.match(accounts.querySelector('[data-row-id="row-a"]').textContent, /7/, "the changed row shows the update");
    assert.equal(accounts.querySelector('[data-row-id="row-b"]'), rowB, "the other row keeps its element");
    assert.equal(changes.get(rowB), 0, "the other row is not repainted");
  } finally { f.destroy(); }
});

test("U06/A04: the Account Manager says plainly when broker rows could not be shown, and clears it after a clean read", async () => {
  let bad = false;
  const f = await mounted({
    configureBroker(broker) {
      const orders = broker.orders.bind(broker);
      broker.orders = async () => [...(await orders()), order({ id: "fine" }), ...(bad ? [order({ id: "broken", status: 99 }), order({ id: "broken-2", limitPrice: Number.NaN })] : [])];
    },
  });
  try {
    const accounts = f.surfaces.get("accounts");
    const note = () => accounts.querySelector('[data-ui="account-unread-rows"]')?.textContent;
    assert.equal(note(), undefined);
    bad = true;
    await f.session.refresh(); await flush();
    assert.equal(note(), "2 rows from your broker could not be shown.");
    assert.doesNotMatch(note(), /quarantin|snapshot|dataset/i, "no internal wording");
    bad = false;
    await f.session.refresh(); await flush();
    assert.equal(note(), undefined);
  } finally { f.destroy(); }
});

test("U07: symbol-free account details render text without an empty-symbol broker lookup", async () => {
  let emptyReads = 0;
  const f = await mounted({ configureBroker(broker,host) {
    const info = broker.symbolInfo.bind(broker), base = broker.accountManagerInfo.bind(broker);
    broker.symbolInfo = symbol => { if (!symbol) { emptyReads++; return Promise.reject(new Error("No empty instrument")); } return info(symbol); };
    broker.accountManagerInfo = () => ({ ...base(), pages:[{ id:"risk",title:"Risk details",tables:[{ id:"metrics",columns:[{id:"metric",label:"Detail",dataFields:["metric"]},{id:"value",label:"Value",dataFields:["value"]}], changeDelegate:host.factory.createDelegate(),getData:async()=>[{id:"margin",metric:"Maintenance margin",value:"12 USDT"}] }] }] });
  }});
  try {
    const accounts = f.surfaces.get("accounts"); button(accounts,"Risk details").click(); await flush(3);
    assert.match(accounts.textContent,/Maintenance margin/); assert.match(accounts.textContent,/12 USDT/); assert.equal(emptyReads,0);
  } finally { f.destroy(); }
});
