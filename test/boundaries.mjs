import { solidPlugin } from 'esbuild-plugin-solid';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';

// Headless entries may only bundle this package's own sources; the UI may also
// use installed packages and the shared Solid list primitives.
const ownSource = filename => filename.startsWith('src/');
const uiSource = filename => ownSource(filename) || filename.includes('node_modules/') || filename.startsWith('../solid-ui/src/');

const contracts = await build({ entryPoints: ['src/contracts/index.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true });
for (const filename of Object.keys(contracts.metafile.inputs)) assert(filename.startsWith('src/contracts/'), `Contracts: ${filename}`);
for (const filename of fs.readdirSync('src/contracts')) assert(!fs.readFileSync(`src/contracts/${filename}`, 'utf8').includes('export as namespace'), filename);
console.log('Contracts import nothing outside src/contracts and declare no global namespace.');
const result = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true });
for (const filename of Object.keys(result.metafile.inputs)) {
  assert(ownSource(filename), filename);
  assert(!/\/(?:ui|mock)\//.test(filename), filename);
}
assert(!/LumenChartingLibraryTrading|document\.|window\./.test(result.outputFiles[0].text));
console.log('Headless root bundles only its own sources: no UI, mock or other packages.');

const ui = await build({ entryPoints: ['src/ui/index.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true, plugins: [solidPlugin()] });
for (const filename of Object.keys(ui.metafile.inputs)) {
  assert(uiSource(filename), filename);
  assert(!/\/mock\//.test(filename), filename);
}
console.log('UI entry bundles its own sources, installed packages and the shared list primitives, and no mock.');

/** Headless entries: only their own sources, no UI; conformance and market data stay mock-free. */
for (const [entry, label, forbidMock] of [
  ['src/mock/index.ts', 'Mock', false],
  ['src/paper/index.ts', 'Paper broker', true],
  ['src/conformance/index.ts', 'Conformance', true],
  ['src/market-data/index.ts', 'Market-data', true],
]) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true });
  for (const filename of Object.keys(built.metafile.inputs)) {
    assert(ownSource(filename), `${label}: ${filename}`);
    assert(!/\/ui\//.test(filename), `${label}: ${filename}`);
    if (forbidMock) assert(!/\/mock\//.test(filename), `${label}: ${filename}`);
  }
  console.log(`${label} entry bundles only its own sources: no UI${forbidMock ? ' or mock' : ''}.`);
}
