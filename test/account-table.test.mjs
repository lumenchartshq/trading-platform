import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
import { ManualClock, deferred, flush } from "./manual-clock.mjs";
const { createTableModel } = await loadModule(
  "src/ui/account-manager/table-model.ts",
);
const { createCustomTableController } = await loadModule(
  "src/ui/account-manager/custom-table.ts",
);
const { EntityStore } = await loadModule("src/core/entity-store.ts");
const { Delegate } = await loadModule("src/compat/delegate.ts");
test("U06/X09: one financial field update reads one row and leaves all stable IDs unchanged", () => {
  const store = new EntityStore(() => {});
  store.replace(
    Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      qty: i,
      extra: { pl: 0 },
    })),
  );
  let reads = 0;
  const reader = {
    ids: () => store.ids(),
    get: (id) => {
      reads++;
      return store.get(id);
    },
    subscribeChanges: (callback) => store.subscribeChanges(callback),
  };
  const model = createTableModel(reader),
    ids = model.ids.get();
  reads = 0;
  store.patch("42", { extra: { pl: 100 } });
  assert.equal(reads, 1);
  assert.equal(model.ids.get(), ids);
  model.setSort("qty", false);
  assert.equal(model.ids.get()[0], "9999");
  model.setFilter((row) => row.qty < 2);
  assert.deepEqual(model.ids.get(), ["1", "0"]);
  store.patch("2", { qty: -1 });
  assert.deepEqual(model.ids.get(), ["1", "0", "2"]);
  model.destroy();
  store.destroy();
});
test("U07: custom rows reconcile delegates during a page load and pagination ends on an empty page", async () => {
  const clock = new ManualClock(),
    changeDelegate = new Delegate(),
    deleteDelegate = new Delegate(),
    pending = deferred(),
    cursors = [];
  const table = {
    id: "custom",
    columns: [],
    changeDelegate,
    deleteDelegate,
    flags: { supportPagination: true },
    getData: (cursor) => {
      cursors.push(cursor);
      if (cursor === undefined) return pending.promise;
      if (cursor === "2") return Promise.resolve([{ id: "3", amount: 30 }]);
      return Promise.resolve([]);
    },
  };
  const controller = createCustomTableController(table, clock),
    first = controller.loadNext();
  changeDelegate.fire({ id: "1", amount: 11 });
  pending.resolve([
    { id: "1", amount: 10 },
    { id: "2", amount: 20 },
  ]);
  await first;
  assert.equal(controller.rows.get("1").amount, 11);
  await controller.loadNext();
  await controller.loadNext();
  assert.equal(controller.state.get().done, true);
  assert.deepEqual(cursors, [undefined, "2", "3"]);
  deleteDelegate.fire("2");
  assert.deepEqual(controller.rows.ids(), ["1", "3"]);
  controller.destroy();
  changeDelegate.fire({ id: "late" });
  assert.equal(controller.rows.ids().length, 0);
  assert.equal(clock.timers.size, 0);
});
test("U07/A05: repeated cursors stop pagination; destruction settles a hanging page and fences late results", async () => {
  const clock = new ManualClock(),
    changeDelegate = new Delegate();
  const repeated = createCustomTableController(
    {
      id: "r",
      columns: [],
      changeDelegate,
      flags: { supportPagination: true },
      getData: async () => [{ id: "1" }],
    },
    clock,
  );
  await repeated.loadNext();
  await repeated.loadNext();
  assert.match(repeated.state.get().error, /repeated/);
  assert.equal(repeated.state.get().done, true);
  repeated.destroy();
  const pending = deferred(),
    controller = createCustomTableController(
      { id: "h", columns: [], changeDelegate, getData: () => pending.promise },
      clock,
    );
  const load = controller.loadNext();
  controller.destroy();
  await load;
  pending.resolve([{ id: "late" }]);
  await flush();
  assert.equal(controller.rows.ids().length, 0);
  assert.equal(clock.timers.size, 0);
});
