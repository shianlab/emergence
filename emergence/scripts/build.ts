import { build } from 'esbuild';
import { rm, copyFile } from 'node:fs/promises';
import { loadCoreCatalog } from '../src/core/adapters/catalog.ts';
import { buildNativeModelConfiguration } from './build-model-config.ts';
import { buildDataAssets } from './build-data-assets.ts';
loadCoreCatalog();
await build({
  entryPoints: { cli: 'src/app/cli.ts', plugin: 'src/app/plugin.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  packages: 'external',
  sourcemap: true,
});
for (const name of ['index.html', 'app.js', 'style.css', 'wordmark.png'])
  await rm(`dist/model-config/web/${name}`, { force: true });
await buildNativeModelConfiguration();
await copyFile('src/app/tui/small-text.ps1', 'dist/small-text.ps1');
await buildDataAssets();
