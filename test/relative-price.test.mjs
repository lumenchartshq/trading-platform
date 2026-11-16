import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./load-module.mjs";
const { relativePriceTicks, priceFromTicks } = await loadModule(
  "src/core/relative-price.ts",
);
const instrument = { minTick: 0.01 };
test("U01/O08: relative entry inputs use actual ticks and preserve signed/negative price offsets", () => {
  assert.equal(relativePriceTicks(100, 100.01, instrument), -1);
  assert.equal(priceFromTicks(-1, 100.01, instrument, "limit"), 100);
  assert.equal(relativePriceTicks(-10.25, -10, instrument), -25);
  assert.equal(priceFromTicks(-25, -10, instrument, "stop"), -10.25);
  assert.equal(relativePriceTicks(0, 0, instrument), 0);
});
test("U01/O08: generated offsets honor explicit order steps and variable ticks", () => {
  assert.equal(
    priceFromTicks(
      7,
      100,
      { minTick: 0.01, variableMinTick: ".01 100 .05" },
      "limit",
    ),
    100.05,
  );
  assert.equal(
    priceFromTicks(
      7,
      100,
      { minTick: 0.01, limitPriceStep: 0.1, stopPriceStep: 0.05 },
      "limit",
    ),
    100.1,
  );
  assert.equal(
    priceFromTicks(
      7,
      100,
      { minTick: 0.01, limitPriceStep: 0.1, stopPriceStep: 0.05 },
      "stop",
    ),
    100.05,
  );
});
test("U01/Q01: relative inputs leave missing anchors and invalid increments unavailable", () => {
  for (const tick of [0, -1, NaN, Infinity]) {
    assert.equal(relativePriceTicks(100, 100, { minTick: tick }), undefined);
    assert(Number.isNaN(priceFromTicks(1, 100, { minTick: tick }, "stop")));
  }
  assert.equal(relativePriceTicks(100, undefined, instrument), undefined);
  assert(Number.isNaN(priceFromTicks(1, undefined, instrument, "stop")));
  assert.equal(relativePriceTicks(undefined, 100, instrument), undefined);
});
