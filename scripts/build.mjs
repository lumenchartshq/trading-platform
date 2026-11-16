import { build } from 'esbuild';
import { solidPlugin } from 'esbuild-plugin-solid';
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--emitDeclarationOnly'], { stdio: 'inherit' });
await build({ entryPoints: ['src/asset.ts', 'src/index.ts', 'src/contracts/index.ts', 'src/contracts/broker.ts', 'src/contracts/market-data.ts', 'src/contracts/ports.ts', 'src/ui/index.ts', 'src/ui/resize-handle.tsx', 'src/mock/index.ts', 'src/paper/index.ts', 'src/market-data/index.ts', 'src/conformance/index.ts'], outbase: 'src', outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', packages: 'external', plugins: [solidPlugin()] });

copyFileSync('src/ui/trading.css', 'dist/ui/trading.css');
// trading.css imports the shared resize handle styles from beside it.
copyFileSync('src/ui/resize-handle.css', 'dist/ui/resize-handle.css');
