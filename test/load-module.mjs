import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory = mkdtempSync(path.join(tmpdir(), 'lumen-trading-tests-'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
export async function loadModule(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
  const code = result.outputFiles[0].text;
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const filename = path.join(directory, `${path.basename(entry, '.ts')}-${hash}.mjs`);
  writeFileSync(filename, code);
  return import(pathToFileURL(filename).href);
}
