import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const directory = mkdtempSync(path.join(tmpdir(), "lumen-trading-host-document-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));

// The browser build of Solid's DOM runtime, as the trading asset ships it.
const result = await build({
  entryPoints: [path.join(packageRoot, "src/ui/host-document.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: { "solid-js": "solid-js/dist/solid.js", "solid-js/web": "solid-js/web/dist/web.js" },
  logLevel: "silent",
});
const code = result.outputFiles[0].text;
const filename = path.join(directory, `host-document-${createHash("sha256").update(code).digest("hex").slice(0, 16)}.mjs`);
writeFileSync(filename, code);
const chart = new JSDOM("<!doctype html><html><body></body></html>");
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: chart.window });
const { adoptSurfaceDocument, focusedElement, isolateLayer } = await import(pathToFileURL(filename).href);

test("X10: a surface the host places in its own document receives delegated events and its own popup layer", () => {
  const host = new JSDOM("<!doctype html><html><body></body></html>").window.document;
  const ownSurface = chart.window.document.createElement("div");
  assert.equal(adoptSurfaceDocument(ownSurface, chart.window.document).popupMount, undefined);

  const accounts = host.createElement("div");
  const ticket = host.createElement("div");
  host.body.append(accounts, ticket);
  const first = adoptSurfaceDocument(accounts, chart.window.document);
  const second = adoptSurfaceDocument(ticket, chart.window.document);
  assert.equal(first.popupMount?.ownerDocument, host);
  assert.equal(host.querySelectorAll('[data-ui="trading-popups"]').length, 2);

  let clicks = 0;
  const button = host.createElement("button");
  // Solid stores a delegated handler on the node and dispatches it from the document listener.
  button.$$click = () => clicks++;
  accounts.append(button);
  button.dispatchEvent(new host.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 1);

  first.release();
  button.dispatchEvent(new host.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 2, "delegation stays while another surface uses the document");
  second.release();
  button.dispatchEvent(new host.defaultView.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 2, "the last release removes delegation this module added");
  assert.equal(host.querySelectorAll('[data-ui="trading-popups"]').length, 0);
});

test("X10: releasing never removes delegation the host document already had", () => {
  const host = new JSDOM("<!doctype html><html><body></body></html>").window.document;
  host._$DX_DELEGATE = new Set();
  const surface = host.createElement("div");
  host.body.append(surface);
  adoptSurfaceDocument(surface, chart.window.document).release();
  assert.ok("_$DX_DELEGATE" in host);
});

test("X10: a dialog in the page restores focus to the control inside the chart frame that opened it", () => {
  const page = new JSDOM('<!doctype html><html><body><button id="page">Page</button><iframe id="chart"></iframe></body></html>');
  const document = page.window.document;
  assert.equal(focusedElement(document), document.body, "nothing focused: the body");
  document.getElementById("page").focus();
  assert.equal(focusedElement(document)?.id, "page");

  const frame = document.getElementById("chart");
  const inner = frame.contentDocument;
  const close = inner.createElement("button");
  close.id = "close-position";
  inner.body.append(close);
  frame.focus();
  close.focus();
  assert.equal(document.activeElement, frame, "the page only sees the frame");
  assert.equal(focusedElement(document), close, "the focused control inside the frame");
  page.window.close();
});

test("X10: a modal dialog in the page isolates the rest of the page, never its own layer, and restores it", () => {
  const page = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="menu" aria-hidden="false"></div><div id="layer"><div id="dialog"></div></div></body></html>');
  const document = page.window.document;
  const app = document.getElementById("app"), menu = document.getElementById("menu"), layer = document.getElementById("layer");
  const restore = isolateLayer(layer);
  assert.equal(app.getAttribute("aria-hidden"), "true");
  assert.equal(app.hasAttribute("inert"), true);
  assert.equal(menu.getAttribute("aria-hidden"), "true");
  assert.equal(layer.getAttribute("aria-hidden"), null, "the dialog's own layer stays exposed");
  assert.equal(layer.hasAttribute("inert"), false);
  assert.equal(document.body.getAttribute("aria-hidden"), null);
  restore();
  assert.equal(app.getAttribute("aria-hidden"), null);
  assert.equal(app.hasAttribute("inert"), false);
  assert.equal(menu.getAttribute("aria-hidden"), "false", "earlier values come back");
  page.window.close();
});
