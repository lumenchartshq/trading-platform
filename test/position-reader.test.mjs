import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./load-module.mjs";
const { createPositionTableReader, needsPositionProfit } = await loadModule(
  "src/ui/account-manager/position-reader.ts",
);
const { createTradingState } = await loadModule("src/core/trading-state.ts");
const { createTableModel } = await loadModule(
  "src/ui/account-manager/table-model.ts",
);
const position = {
  id: "P",
  symbol: "X",
  qty: 2,
  side: 1,
  avgPrice: 100,
  extra: { pl: 17, note: "broker" },
};
const individual = {
  ...position,
  id: "I",
  date: 1000,
  price: 100,
  pl: 17,
  visiblePL: 17,
};
test("P01/U06: table-only money projects canonical table fields without mutating chart position data", () => {
  const state = createTradingState();
  const net = createPositionTableReader(state.positions, state.tablePL),
    lots = createPositionTableReader(
      state.individualPositions,
      state.individualTablePL,
      true,
    );
  try {
    state.positionUpdate(position);
    state.individualPositionUpdate(individual);
    const ids = net.reader.ids(),
      events = [];
    net.reader.get("P");
    net.reader.subscribeChanges((change) => events.push(change));
    state.tablePL.upsert({ id: "P", value: 50 });
    state.individualTablePL.upsert({ id: "I", value: 80 });
    const row = net.reader.get("P");
    assert.equal(row.extra.pl, 50);
    assert.equal(row.unrealizedPl, 50);
    assert.equal(row.extra.note, "broker");
    assert.equal(net.reader.ids(), ids);
    assert.equal(net.reader.get("P"), row);
    assert.equal(state.positions.get("P").extra.pl, 17);
    assert.equal(lots.reader.get("I").pl, 80);
    assert.equal(lots.reader.get("I").visiblePL, 80);
    assert.equal(state.individualPositions.get("I").pl, 17);
    assert.deepEqual(events[0].updated, ["P"]);
    state.tablePL.upsert({ id: "P", value: 50 });
    assert.equal(events.length, 1);
    assert.throws(() => {
      row.extra.pl = 999;
    }, TypeError);
  } finally {
    net.destroy();
    lots.destroy();
    state.destroy();
  }
});
test("P01/A04: early financial updates wait for a position, while removal/snapshot clearing prevents stale money on ID reuse", () => {
  const state = createTradingState(),
    view = createPositionTableReader(state.positions, state.tablePL);
  try {
    state.tablePL.upsert({ id: "P", value: 50 });
    assert.equal(view.reader.get("P"), undefined);
    assert.deepEqual(view.reader.ids(), []);
    state.positionUpdate(position);
    assert.equal(view.reader.get("P").extra.pl, 50);
    state.positionUpdate({ ...position, qty: 0 });
    assert.equal(state.tablePL.get("P"), undefined);
    assert.equal(view.reader.get("P"), undefined);
    state.positionUpdate({ ...position, extra: { pl: 5 } });
    assert.equal(view.reader.get("P").extra.pl, 5);
    state.tablePL.upsert({ id: "P", value: 60 });
    state.positions.replace([]);
    assert.equal(state.tablePL.get("P"), undefined);
    state.individualPositionUpdate(individual);
    state.individualTablePL.upsert({ id: "I", value: 80 });
    state.individualPositions.replace([]);
    assert.equal(state.individualTablePL.get("I"), undefined);
  } finally {
    view.destroy();
    state.destroy();
  }
});
test("P01/U06/X09: one table PL push reads one financial record, no base rows or ID lists, and retains sorted IDs", () => {
  const state = createTradingState();
  state.positions.replace(
    Array.from({ length: 10000 }, (_, index) => ({
      ...position,
      id: String(index),
      qty: index + 1,
    })),
  );
  let baseReads = 0,
    financialReads = 0,
    idReads = 0;
  const base = {
    ids: () => {
      idReads++;
      return state.positions.ids();
    },
    get: (id) => {
      baseReads++;
      return state.positions.get(id);
    },
    revision: (id) => state.positions.revision(id),
    subscribeChanges: (listener) => state.positions.subscribeChanges(listener),
  };
  const financial = {
    ids: () => state.tablePL.ids(),
    get: (id) => {
      financialReads++;
      return state.tablePL.get(id);
    },
    revision: (id) => state.tablePL.revision(id),
    subscribeChanges: (listener) => state.tablePL.subscribeChanges(listener),
  };
  const view = createPositionTableReader(base, financial),
    model = createTableModel(view.reader);
  try {
    model.setSort("qty", false);
    const ids = model.ids.get(),
      untouched = view.reader.get("1");
    baseReads = 0;
    financialReads = 0;
    idReads = 0;
    state.tablePL.upsert({ id: "42", value: 40 });
    assert.equal(baseReads, 0);
    assert.equal(financialReads, 1);
    assert.equal(idReads, 0);
    assert.equal(model.ids.get(), ids);
    assert.equal(view.reader.get("1"), untouched);
  } finally {
    model.destroy();
    view.destroy();
    state.destroy();
  }
});
test("U01/P01: broker PL projection can be disabled without losing later values or subscriptions on destroy", () => {
  const state = createTradingState(),
    view = createPositionTableReader(state.positions, state.tablePL);
  try {
    state.positionUpdate(position);
    state.tablePL.upsert({ id: "P", value: 50 });
    assert.equal(view.reader.get("P").extra.pl, 50);
    view.setEnabled(false);
    assert.equal(view.reader.get("P"), state.positions.get("P"));
    state.tablePL.upsert({ id: "P", value: 70 });
    view.setEnabled(true);
    assert.equal(view.reader.get("P").extra.pl, 70);
    view.destroy();
    state.tablePL.upsert({ id: "P", value: 80 });
    assert.equal(view.reader.get("P"), undefined);
    assert.deepEqual(view.reader.ids(), []);
    assert.equal(view.reader.revision("P"), 0);
  } finally {
    view.destroy();
    state.destroy();
  }
});

test("P01/U06: table financial dependencies include nested money, whole-row formatters and sorting/search fields", () => {
  assert.equal(needsPositionProfit(["symbol", "qty"], false), false);
  assert.equal(needsPositionProfit([], true), true);
  for (const field of [["extra", "pl"], ["extra"], "extra", "unrealizedPl", "pl", "visiblePL"])
    assert.equal(needsPositionProfit([field], false), true);
  assert.equal(needsPositionProfit([["extra", "providerNote"]], false), false);
});
