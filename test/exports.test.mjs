import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { solidPlugin } from 'esbuild-plugin-solid';
import { fileURLToPath } from 'node:url';

async function runtimeExports(entry, solid = false) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
    bundle: true, write: false, platform: solid ? 'browser' : 'node', format: 'esm', metafile: true,
    ...(solid ? { packages: 'external', plugins: [solidPlugin()] } : { external: ['solid-js', '@kobalte/*'] }),
  });
  return Object.values(result.metafile.outputs)[0].exports.sort();
}

// Additions are deliberate: update this list in the same change that widens the public surface.
test('X08: the root runtime export list is fixed', async () => {
  assert.deepEqual(await runtimeExports('src/index.ts'), [
    'TradingError', 'createDefaultTradingFormatters', 'createNumericFormatter', 'createPriceFormatter', 'createTradingSession',
    'cryptoBaseQuantity', 'cryptoQuoteAmount', 'defaultFlags', 'durationsForType', 'executablePrice', 'liquidationPrice',
    'marginRequired', 'normalizeBrokerConfig', 'orderEntryPrice', 'orderNotional', 'positionProfit', 'quantityForRisk',
    'resolveCapabilities', 'resolveTradingFeatures', 'riskBudget', 'tradingFeatureDefaults',
  ]);
});
test('X08: the market-data entry exports its adapter factory and quote normalisation only', async () => {
  assert.deepEqual(await runtimeExports('src/market-data/index.ts'), ['createTradingMarketData', 'normalizeQuotes']);
});
test('X08: the mock, conformance, paper and UI entries export a fixed list', async () => {
  assert.deepEqual(await runtimeExports('src/mock/index.ts'), ['SimulationClock', 'createDeterministicBroker', 'simulationProfiles']);
  assert.deepEqual(await runtimeExports('src/conformance/index.ts'), ['conformanceScenarios', 'createReplayBroker', 'recordBroker', 'runConformance']);
  assert.deepEqual(await runtimeExports('src/paper/index.ts'), [
    'PaperRejection', 'createPaperBroker', 'defaultQuoteMaxAgeMs', 'executableQuote', 'intervalFinanceSchedule', 'netFill', 'onTick', 'paperBrokerConfig',
    'shouldFill', 'validQuantity', 'validateProtection',
  ]);
  assert.deepEqual(await runtimeExports('src/ui/index.ts', true), [
    'AccountManagerView', 'DepthPanelView', 'OrderTicketView', 'createDomController', 'createTicketController', 'mountTradingPlatform',
  ]);
});
