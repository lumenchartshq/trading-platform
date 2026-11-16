// Headless active-trading benchmark: dense orders, chart overlay projection, quote streams and depth deltas.
// Prints timings (median of runs) with work counts; counts are the regression contract, timings are context only.
// Usage: node scripts/bench-active-trading.mjs [--orders 5000] [--quotes 2000] [--depth 2000] [--runs 5] [--out file.json]
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadModule } from '../test/load-module.mjs';
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const orders = Number(option('orders', 5000)), quotes = Number(option('quotes', 2000)), depthDeltas = Number(option('depth', 2000)), runs = Number(option('runs', 5));
const { createTradingSession } = await loadModule('src/core/session.ts');
const { createDeterministicBroker } = await loadModule('src/mock/broker.ts');
const { createOverlayCoordinator } = await loadModule('src/chart/overlay-coordinator.ts');
const { DepthBook } = await loadModule('src/market-data/depth-book.ts');
const { ValueStore } = await loadModule('src/core/value-store.ts');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function scenario() {
  const simulation = createDeterministicBroker();
  simulation.brokerConfig.configFlags.supportPLUpdate = false;
  let host;
  const session = createTradingSession({
    ...simulation,
    brokerFactory: (value) => { host = value; return simulation.brokerFactory(value); },
    settings: { get: () => undefined, set() {}, remove() {} },
    formatters: { defaultPrice: async () => ({ format: String }), numeric: async () => ({ format: (value) => value.toFixed(2) }), quantity: async () => ({ format: String }), createPriceFormatter: () => ({ format: String }) },
  });
  await session.ready;
  const work = { created: 0, updates: 0 };
  const chart = {
    binding: new ValueStore({ id: 'bench', generation: 1, symbol: 'SIM:X' }),
    registerContextActions: () => () => {}, onTradeIntent: () => () => {}, symbolContext: async () => ({}),
    createOverlay() { work.created++; return { update() { work.updates++; }, cancelInteraction() {}, remove() {}, subscribe: () => () => {} }; },
  };
  const collection = { charts: () => [chart], activeChart: () => chart, subscribe: () => () => {} };
  const result = {};
  let start = performance.now();
  for (let index = 0; index < orders; index++)
    host.orderUpdate({ id: `bench-${index}`, symbol: 'SIM:X', side: index % 2 ? 1 : -1, type: 1, qty: 1, limitPrice: 90 + (index % 200) / 10, status: 6 });
  result.ingestOrdersMs = performance.now() - start;
  start = performance.now();
  const coordinator = createOverlayCoordinator(session, collection, () => {});
  await flush(); await flush();
  result.projectOverlaysMs = performance.now() - start;
  result.overlaysCreated = work.created;
  work.updates = 0;
  start = performance.now();
  host.orderUpdate({ id: 'bench-7', symbol: 'SIM:X', side: 1, type: 1, qty: 1, limitPrice: 95.55, status: 6 });
  result.singleOrderUpdateMs = performance.now() - start;
  result.overlayUpdatesForOneOrder = work.updates;
  work.updates = 0;
  start = performance.now();
  for (let index = 0; index < quotes; index++) simulation.controls.quote('SIM:X', 100 + (index % 50) / 100);
  await flush();
  result.quoteStreamMs = performance.now() - start;
  result.overlayUpdatesPerQuote = work.updates / quotes;
  coordinator.destroy();
  // The same burst with frame batching (as mounted in a browser): one projection per affected overlay.
  const frames = [];
  const framed = createOverlayCoordinator(session, collection, () => {}, () => {}, undefined, (callback) => { frames.push(callback); return () => {}; });
  await flush(); await flush();
  while (frames.length) frames.shift()();
  work.updates = 0;
  start = performance.now();
  for (let index = 0; index < quotes; index++) simulation.controls.quote('SIM:X', 101 + (index % 50) / 100);
  await flush();
  while (frames.length) frames.shift()();
  result.framedQuoteBurstMs = performance.now() - start;
  result.framedOverlayUpdatesPerBurst = work.updates;
  framed.destroy(); session.destroy();
  const book = new DepthBook(0.01);
  const level = (price, volume) => ({ price, volume });
  book.apply({ snapshot: true, bids: Array.from({ length: 200 }, (_, index) => level(99.99 - index / 100, 10)), asks: Array.from({ length: 200 }, (_, index) => level(100.01 + index / 100, 10)) });
  start = performance.now();
  for (let index = 0; index < depthDeltas; index++) book.apply({ snapshot: false, bids: [level(99.99 - (index % 200) / 100, index % 7)], asks: [] });
  result.depthDeltasMs = performance.now() - start;
  return result;
}
const samples = [];
for (let run = 0; run < runs; run++) samples.push(await scenario());
const summary = Object.fromEntries(Object.keys(samples[0]).map((key) => [key, Number(median(samples.map((sample) => sample[key])).toFixed(3))]));
const report = { node: process.version, orders, quotes, depthDeltas, runs, median: summary };
const out = option('out');
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
// Contract: one changed order or quote updates exactly one overlay.
if (summary.overlayUpdatesForOneOrder !== 1 || summary.overlayUpdatesPerQuote !== 1 || summary.framedOverlayUpdatesPerBurst !== 1) {
  console.error('Work-count regression: an update touched unrelated overlays.');
  process.exitCode = 1;
}
