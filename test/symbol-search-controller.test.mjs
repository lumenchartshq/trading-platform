import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModule } from './load-module.mjs';
import { ManualClock, deferred, flush } from './manual-clock.mjs';
const { createSymbolSearchController } = await loadModule('src/ui/order-ticket/symbol-search-controller.ts');
const { PagedListWindow } = await loadModule('test/support/solid-ui.ts');
const item = symbol => ({ symbol });

function fixture({ paged = true } = {}) {
  const clock = new ManualClock(), pages = [], chosen = [];
  const controller = createSymbolSearchController({
    clock,
    search: async query => Array.from({ length: 30 }, (_, i) => item(`${query}${i}`)),
    searchPage: paged ? (query, start, limit) => { const page = deferred(); pages.push({ query, start, limit, page }); return page.promise; } : undefined,
    choose: symbol => chosen.push(symbol),
    createWindow: (load, changed) => new PagedListWindow(entry => entry.symbol, load, changed),
  });
  return { clock, controller, pages, chosen };
}

test('U09: typing debounces the search and only the newest request publishes results', async () => {
  const { clock, controller, pages } = fixture();
  controller.input('EU'); clock.advance(100); controller.input('EUR');
  clock.advance(199); assert.equal(pages.length, 0);
  clock.advance(1); assert.equal(pages.length, 1); assert.equal(pages[0].query, 'EUR');
  assert.equal(controller.state.get().loading, true);
  controller.input('GBP'); clock.advance(200);
  pages[0].page.resolve({ items: [item('EURUSD')], remaining: 0, revision: 'r1' }); await flush();
  assert.equal(controller.results.count, 0, 'a superseded request cannot publish');
  pages[1].page.resolve({ items: [item('GBPUSD'), item('GBPJPY')], remaining: 0, revision: 'r1' }); await flush();
  assert.equal(controller.results.count, 2); assert.equal(controller.state.get().loading, false);
  controller.destroy();
});
test('U09: paging appends, a changed catalog revision restarts the search and Enter chooses the selection', async () => {
  const { clock, controller, pages, chosen } = fixture();
  controller.input('X'); clock.advance(200);
  pages[0].page.resolve({ items: [item('X1'), item('X2')], remaining: 5, revision: 'r1' }); await flush();
  assert.equal(controller.state.get().more, true);
  controller.loadMore();
  assert.equal(pages[1].start, 2);
  pages[1].page.resolve({ items: [item('X3')], remaining: 0, revision: 'r1' }); await flush();
  assert.equal(controller.results.count, 3); assert.equal(controller.state.get().more, false);
  controller.move(1); controller.move(1); controller.move(1);
  assert.equal(controller.state.get().selected, 2); assert.equal(controller.state.get().keyboard, true);
  await controller.submit();
  assert.deepEqual(chosen, ['X3']); assert.equal(controller.state.get().query, '');
  controller.input('Y'); clock.advance(200);
  pages[2].page.resolve({ items: [item('Y1')], remaining: 3, revision: 'r1' }); await flush();
  controller.loadMore();
  pages[3].page.resolve({ items: [item('Y2')], remaining: 0, revision: 'r2' }); await flush();
  assert.equal(pages.length, 5, 'a new catalog revision restarts from the first page');
  assert.equal(pages[4].start, 0);
  controller.destroy();
});
test('U09: a failed search can be retried; unpaged search shows the first results and Enter searches now', async () => {
  const failing = fixture();
  failing.controller.input('Z'); failing.clock.advance(200);
  failing.pages[0].page.reject(new Error('offline')); await flush();
  assert.equal(failing.controller.state.get().failed, true);
  failing.controller.retry();
  assert.equal(failing.pages.length, 2); assert.equal(failing.controller.state.get().failed, false);
  failing.controller.destroy();
  const unpaged = fixture({ paged: false });
  unpaged.controller.input('Q');
  await unpaged.controller.submit(); await flush();
  assert.deepEqual(unpaged.chosen, ['Q0'], 'Enter before the debounce searches and chooses the first result');
  unpaged.controller.input('Q'); unpaged.clock.advance(200); await flush();
  assert.equal(unpaged.controller.results.count, 20);
  unpaged.controller.destroy(); assert.equal(unpaged.clock.timers.size, 0);
});
