import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./load-module.mjs";
import { ManualClock, deferred, flush } from "./manual-clock.mjs";
const { createTableCsv, csvCell, tableExportLimits } = await loadModule(
  "src/ui/account-manager/table-export.ts",
);
const { EntityStore } = await loadModule("src/core/entity-store.ts");
const formats = {
  price: { format: String },
  quantity: { format: String },
  numeric: { format: String },
  integer: { format: String },
  variable: { format: String },
};
function fixture(
  rows,
  columns = [
    { id: "id", label: "ID", dataFields: ["id"] },
    {
      id: "qty",
      label: "Quantity",
      dataFields: ["qty"],
      formatter: "formatQuantity",
    },
  ],
) {
  const reader = new EntityStore(() => {}),
    clock = new ManualClock();
  reader.replace(rows);
  return {
    reader,
    clock,
    ids: reader.ids(),
    columns,
    environment: { locale: "en", timezone: "UTC" },
    formatters: async () => formats,
    assertCurrent() {},
  };
}
test("U06: export includes every filtered/sorted ID beyond the rendering window and quotes CSV cells", async () => {
  const f = fixture(
    Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      qty: index + 1,
    })),
  );
  try {
    const ids = [...f.ids].reverse(),
      csv = await createTableCsv({ ...f, ids });
    const lines = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.equal(lines.length, 51);
    assert.equal(lines[1], '"49","50"');
    assert.equal(lines.at(-1), '"0","1"');
    assert.equal(csvCell('a,"b"\nnext'), '"a,""b""\nnext"');
    assert.equal(f.clock.timers.size, 0);
  } finally {
    f.reader.destroy();
  }
});
test("U06: spreadsheet formula prefixes are escaped, including whitespace and malicious headers", async () => {
  for (const value of [
    "=1+1",
    "+CMD()",
    "-CMD()",
    "@SUM(A1)",
    " \t=HYPERLINK()",
    "\uFEFF=1",
    "\0=CMD()",
  ])
    assert(csvCell(value).startsWith("\"'"), value);
  assert.equal(csvCell("-1.25"), '"-1.25"');
  assert.equal(csvCell("-1e-7"), '"-1e-7"');
  assert.equal(csvCell("safe text"), '"safe text"');
  const f = fixture(
    [{ id: "=HYPERLINK()", qty: 2 }],
    [{ id: "id", label: "=header", dataFields: ["id"] }],
  );
  try {
    assert.match(await createTableCsv(f), /"'=header"\r\n"'=HYPERLINK\(\)"/);
  } finally {
    f.reader.destroy();
  }
});
test("U06/U08: export uses custom text formatting and never invokes its DOM callback", async () => {
  const f = fixture(
    [{ id: "A", qty: 2 }],
    [
      {
        id: "custom",
        label: "Value",
        dataFields: ["qty"],
        formatter: "custom",
      },
    ],
  );
  try {
    const csv = await createTableCsv({
      ...f,
      custom: [
        {
          name: "custom",
          formatText: ({ values, prevValues }) => {
            assert.equal(prevValues, undefined);
            return `Q ${values[0]}`;
          },
          formatElement: () => assert.fail("DOM callback used for export"),
        },
      ],
      formatters: () =>
        assert.fail("custom-only export requested standard services"),
    });
    assert(csv.includes('"Q 2"'));
  } finally {
    f.reader.destroy();
  }
});
test("A04/U06: export captures immutable rows and column metadata before awaiting providers", async () => {
  const f = fixture([{ id: "A", qty: 2 }]),
    pending = deferred();
  f.columns[1].formatter = "custom";
  const formatter = {
    name: "custom",
    formatText: ({ values }) => `old ${values[0]}`,
  };
  try {
    const csv = createTableCsv({
      ...f,
      custom: [formatter],
      formatters: () => pending.promise,
    });
    f.reader.patch("A", { qty: 9 });
    f.columns[0].label = "Changed";
    f.columns[1].dataFields[0] = "id";
    formatter.formatText = () => "new callback";
    pending.resolve(formats);
    const result = await csv;
    assert(result.includes('"ID","Quantity"'));
    assert(result.includes('"A","old 2"'));
    assert(!result.includes("Changed"));
  } finally {
    f.reader.destroy();
  }
});
test("A02/A03/U06: interrupted, timed-out and stale-account exports settle without a partial file or leaked timer", async () => {
  for (const reason of ["abort", "timeout", "account"]) {
    const f = fixture([{ id: "A", qty: 2 }]),
      pending = deferred(),
      controller = new AbortController();
    let current = true;
    try {
      const result = assert.rejects(
        createTableCsv({
          ...f,
          signal: controller.signal,
          formatters: () => pending.promise,
          assertCurrent() {
            if (!current) throw new Error("account changed");
          },
        }),
        reason === "timeout" ? /too long/ : /stopped|account changed/,
      );
      await flush();
      if (reason === "abort") controller.abort();
      if (reason === "timeout") f.clock.advance(tableExportLimits.milliseconds);
      if (reason === "account") {
        current = false;
        pending.resolve(formats);
      }
      await result;
      assert.equal(f.clock.timers.size, 0);
    } finally {
      f.reader.destroy();
    }
  }
});
test("U06: export capacity rejects before hydrating any rows, and formatter failure rejects the entire export", async () => {
  const f = fixture([{ id: "A", qty: 2 }]);
  let reads = 0;
  try {
    await assert.rejects(
      createTableCsv({
        ...f,
        ids: Array(tableExportLimits.rows + 1).fill("A"),
        reader: {
          ...f.reader,
          get() {
            reads++;
            assert.fail("oversized export read a row");
          },
        },
      }),
      /Too many/,
    );
    assert.equal(reads, 0);
    await assert.rejects(
      createTableCsv({
        ...f,
        custom: [
          {
            name: "bad",
            formatText: () => {
              throw new Error("custom export failed");
            },
          },
        ],
        columns: [
          { id: "bad", label: "Bad", dataFields: ["qty"], formatter: "bad" },
        ],
      }),
      /custom export failed/,
    );
    assert.equal(f.clock.timers.size, 0);
  } finally {
    f.reader.destroy();
  }
});
