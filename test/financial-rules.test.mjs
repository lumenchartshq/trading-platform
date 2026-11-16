import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./load-module.mjs";
const {
  positionProfit,
  riskBudget,
  quantityForRisk,
  cryptoBaseQuantity,
  cryptoQuoteAmount,
  executablePrice,
  orderEntryPrice,
  marginRequired,
  orderNotional,
} = await loadModule("src/core/financial-rules.ts");
const instrument = {
  description: "Stock",
  type: "stock",
  currency: "USD",
  pipSize: 0.01,
  minTick: 0.01,
  pipValue: 1,
  qty: { min: 1, max: 100, step: 1 },
};
const position = {
  side: 1,
  qty: 2,
  avgPrice: 100,
  extra: { pl: 17, fees: -3 },
};
test("P01/P02: money channels stay separate and ticks/percentage use liquidation quotes", () => {
  const base = {
    position,
    instrument,
    quotes: { bid: 101, ask: 102 },
    mode: "money",
    supportPLUpdate: true,
    source: "chart",
    tablePL: 25,
  };
  assert.equal(positionProfit(base), 17);
  assert.equal(positionProfit({ ...base, source: "table" }), 25);
  assert.equal(positionProfit({ ...base, mode: "ticks" }), 100);
  assert.equal(positionProfit({ ...base, mode: "percentage" }), 1);
  assert.equal(positionProfit({ ...base, supportPLUpdate: false }), 200);
  assert.equal(
    positionProfit({
      ...base,
      position: { ...position, side: -1 },
      supportPLUpdate: false,
    }),
    -400,
  );
  assert.equal(
    positionProfit({
      ...base,
      position: { ...position, avgPrice: 0 },
      mode: "percentage",
    }),
    undefined,
  );
  assert.equal(
    positionProfit({ ...base, quotes: undefined, mode: "ticks" }),
    undefined,
  );
  assert.equal(
    positionProfit({ ...base, quotes: { trade: 101 }, mode: "ticks" }),
    100,
  );
  assert.equal(
    positionProfit({
      ...base,
      pipValues: { buyPipValue: 2, sellPipValue: 3 },
      supportPLUpdate: false,
    }),
    400,
  );
  assert.equal(
    positionProfit({
      ...base,
      instrument: { ...instrument, pipValue: 0 },
      supportPLUpdate: false,
    }),
    undefined,
  );
});
test("P03: risk quantity floors to step, caps max and requires valid units/equity", () => {
  const input = {
    entry: 100,
    stop: 99,
    budget: 250,
    instrument,
    side: 1,
    currency: "account",
    accountCurrency: "USD",
  };
  assert.deepEqual(quantityForRisk(input), {
    qty: 2,
    perUnitRisk: 100,
    actualRisk: 200,
  });
  assert.equal(riskBudget(1, "percentage", 10000), 100);
  assert.equal(riskBudget(1, "percentage"), undefined);
  assert.equal(riskBudget(-1, "money"), undefined);
  assert.equal(quantityForRisk({ ...input, budget: 99 }), undefined);
  assert.equal(quantityForRisk({ ...input, stop: 100 }), undefined);
  assert.equal(
    quantityForRisk({ ...input, instrument: { ...instrument, pipSize: 0 } }),
    undefined,
  );
  assert.equal(
    quantityForRisk({
      ...input,
      instrument: { ...instrument, qty: { min: 1, max: 1, step: 1 } },
    }).qty,
    1,
  );
  assert.equal(quantityForRisk({ ...input, entry: -100, stop: -101 }).qty, 2);
});
test("P03: instrument risk needs a known point value when currencies differ", () => {
  const input = {
    entry: 100,
    stop: 99,
    budget: 5,
    instrument: { ...instrument, currency: "GBP" },
    side: 1,
    currency: "instrument",
    accountCurrency: "USD",
  };
  assert.equal(quantityForRisk(input), undefined);
  assert.deepEqual(
    quantityForRisk({
      ...input,
      instrument: {
        ...input.instrument,
        bigPointValue: 20,
        priceMagnifier: 10,
      },
    }),
    { qty: 2, perUnitRisk: 2, actualRisk: 4 },
  );
});
test("P04: crypto conversion uses executable side/proposed limit and rejects missing prices", () => {
  const quotes = { bid: 99, ask: 101, trade: 100 };
  const market = { symbol: "X", side: 1, type: 2, qty: 1 };
  assert.equal(executablePrice(1, quotes), 101);
  assert.equal(executablePrice(-1, quotes), 99);
  assert.equal(orderEntryPrice(market, quotes), 101);
  assert.equal(
    orderEntryPrice({ ...market, type: 1, limitPrice: 90 }, quotes),
    90,
  );
  assert.equal(cryptoBaseQuantity(250, 101, instrument.qty), 2);
  assert.equal(cryptoQuoteAmount(2, 101), 202);
  assert.equal(cryptoBaseQuantity(50, 101, instrument.qty), undefined);
  assert.equal(cryptoBaseQuantity(250, 0, instrument.qty), undefined);
  assert.equal(cryptoBaseQuantity(250, undefined, instrument.qty), undefined);
});
test("P03: margin requires compatible currency and explicit contract units", () => {
  assert.equal(orderNotional(2, 100, instrument), 200);
  assert.equal(marginRequired(200, 0.1, "USD", "USD"), 20);
  assert.equal(marginRequired(200, 0.1, "GBP", "USD"), undefined);
  assert.equal(marginRequired(200, undefined, "USD", "USD"), undefined);
  assert.equal(
    orderNotional(1, 1.1, { ...instrument, type: "forex" }),
    undefined,
  );
  assert(
    Math.abs(
      orderNotional(1, 1.1, { ...instrument, type: "forex", lotSize: 100000 }) -
        110000,
    ) < 1e-8,
  );
});

test("P02/P03: per-unit tick value uses account-currency pip values, tick/pip ratio and active side", async () => {
  const { instrumentTickValue } = await loadModule(
    "src/core/financial-rules.ts",
  );
  const fx = { ...instrument, minTick: 0.00001, pipSize: 0.0001, pipValue: 10 };
  assert.equal(instrumentTickValue(1, fx), 1);
  assert.equal(
    instrumentTickValue(-1, fx, { buyPipValue: 20, sellPipValue: 30 }),
    3,
  );
  assert.equal(instrumentTickValue(1, { ...fx, pipSize: undefined }), 10);
  assert.equal(instrumentTickValue(1, { ...fx, pipValue: 0 }), undefined);
  assert.equal(instrumentTickValue(1, { ...fx, minTick: NaN }), undefined);
});

test('P02: tick formatter precision preserves fractional pips and percentage follows the pinned signed entry denominator', async () => {
  const { profitTickPrecision } = await loadModule('src/core/financial-rules.ts');
  assert.equal(profitTickPrecision({ minTick: .01, pipSize: .1 }), 1);
  assert.equal(profitTickPrecision({ minTick: .00001, pipSize: .0001 }), 1);
  assert.equal(profitTickPrecision({ minTick: .01, pipSize: 0 }), 0);
  assert.equal(profitTickPrecision({ minTick: .25, pipSize: .1 }), 1);
  assert.equal(profitTickPrecision({ minTick: 0, pipSize: .1 }), undefined);
  assert.equal(positionProfit({ position: { side: 1, qty: 2, avgPrice: -10 }, instrument: { minTick: .01, pipSize: .01, pipValue: 1 }, quotes: { bid: -9 }, mode: 'percentage', supportPLUpdate: true, source: 'chart' }), -10);
});
