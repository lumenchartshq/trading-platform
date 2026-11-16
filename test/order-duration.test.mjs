import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
const {
  expirationSeconds,
  displayDateTime,
  defaultDuration,
  durationOptions,
  withDefaultDuration,
} = await loadModule("src/core/order-duration.ts");
const { resolveCapabilities } = await loadModule("src/core/capabilities.ts");
const policy = resolveCapabilities({
  durations: [
    { name: "Good until cancelled", value: "GTC", default: true },
    { name: "Date", value: "GTD", hasDatePicker: true },
  ],
});
test("U02: broker default uses type and symbol restrictions, while existing orders retain their duration", () => {
  const order = { symbol: "X", type: 1, side: 1, qty: 1 };
  assert.deepEqual(defaultDuration(policy, 1), { type: "GTC" });
  assert.equal(defaultDuration(policy, 2), undefined);
  assert.deepEqual(
    durationOptions(policy, 1, { allowedDurations: ["GTD"] }).map(
      (value) => value.value,
    ),
    ["GTD"],
  );
  assert.equal(
    defaultDuration(policy, 1, { allowedDurations: ["GTD"] }),
    undefined,
  );
  assert.equal(
    withDefaultDuration({ ...order, id: "O" }, policy).duration,
    undefined,
  );
  assert.deepEqual(withDefaultDuration(order, policy).duration, {
    type: "GTC",
  });
  assert.deepEqual(
    withDefaultDuration(
      { ...order, duration: { type: "GTD", datetime: 1900000000 } },
      policy,
    ).duration,
    { type: "GTD", datetime: 1900000000 },
  );
});
test("U02: expiration converts configured timezone boundaries into Unix seconds and round trips display fields", () => {
  const utc = Date.UTC(2026, 10, 1, 16, 30) / 1000;
  assert.equal(
    expirationSeconds(
      { date: "2026-11-02", time: "00:30" },
      "Asia/Kuala_Lumpur",
    ),
    utc,
  );
  assert.deepEqual(displayDateTime(utc, "Asia/Kuala_Lumpur"), {
    date: "2026-11-02",
    time: "00:30:00",
  });
  assert.equal(
    expirationSeconds({ date: "2026-11-01", time: "16:30:00" }, "UTC"),
    utc,
  );
  assert.equal(
    expirationSeconds({ date: "2028-02-29", time: "00:00" }, "UTC"),
    Date.UTC(2028, 1, 29) / 1000,
  );
});
test("U02: invalid dates, timezone names, DST gaps and repeated times fail closed", () => {
  for (const input of [
    { date: "2026-02-29", time: "12:00" },
    { date: "2026-04-31", time: "12:00" },
    { date: "2026-01-01", time: "24:00" },
    { date: "2026-01-01", time: "12:60" },
  ])
    assert.equal(expirationSeconds(input, "UTC"), undefined);
  assert.equal(
    expirationSeconds(
      { date: "2026-03-08", time: "02:30" },
      "America/New_York",
    ),
    undefined,
  );
  assert.equal(
    expirationSeconds(
      { date: "2026-11-01", time: "01:30" },
      "America/New_York",
    ),
    undefined,
  );
  assert.equal(
    expirationSeconds(
      { date: "2026-03-08", time: "03:30" },
      "America/New_York",
    ),
    Date.UTC(2026, 2, 8, 7, 30) / 1000,
  );
  assert.equal(
    expirationSeconds({ date: "2026-01-01", time: "12:00" }, "Unknown/Zone"),
    undefined,
  );
  assert.equal(displayDateTime(NaN, "UTC"), undefined);
});
