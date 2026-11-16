import { build } from 'esbuild';
import { dump } from 'js-yaml';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { saveConfig } from '../src/app/config.ts';
import { modelProviders } from '../src/app/model-config-runtime.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { configurationModelServer } from './fixtures/configuration-model-server.ts';

const preview = process.argv.includes('--preview'),
  audit = process.argv.includes('--audit'),
  parent = resolve('../artifacts/model-configuration');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'runtime-')),
  home = join(root, 'home'),
  cwd = join(root, '项目');
await mkdir(cwd);
const fixture = await configurationModelServer();
const config = structuredClone(defaultConfig);
config.models[0].baseURL = fixture.baseURL;
config.models[0].apiKeyEnv = 'MODEL_CONFIGURATION_FIXTURE_KEY';
config.models[0].model = 'fixture-first';
await saveConfig(home, config);
// Put the fixture under the package tree so external dependencies resolve normally.
const entry = resolve('node_modules/.cache/model-configuration', root.split(/[\\/]/).at(-1)!, 'plugin.mjs');
await mkdir(resolve(entry, '..'), { recursive: true });
await build({
  entryPoints: ['tests/fixtures/model-config-runtime-plugin.ts'],
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
// Native preview uses exactly the same executable as the production build.
if (process.platform === 'win32' && process.argv.includes('--native')) {
  const { cp } = await import('node:fs/promises');
  await cp('dist/model-config', resolve(entry, '../model-config'), { recursive: true });
}
const profile = join(home, 'harness/profiles/model-config-fixture');
await mkdir(profile, { recursive: true });
await writeFile(
  join(profile, 'package.json'),
  JSON.stringify({
    name: 'model-config-fixture',
    type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }),
);
await writeFile(
  join(profile, 'cordis.patch.yml'),
  dump(
    [
      ...[
        'hmr',
        'session-log-deepseek',
        'plugin-package-inventory-deepseek',
        'session-telemetry-otel',
        'session-title-llm',
        'agent-instructions',
        'permission',
        'pwsh-sandbox',
      ].map((id) => ({ id, disabled: true })),
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'llm-pi-ai', config: { providers: modelProviders(config) } },
      {
        insert: [
          {
            id: 'model-config-fixture',
            name: entry.replaceAll('\\', '/'),
            config: { home, cwd, preview, audit, native: process.argv.includes('--native') },
          },
        ],
      },
    ],
    { lineWidth: 140 },
  ),
);
const require = createRequire(import.meta.url),
  bin = join(require.resolve('@deepseek-ai/dsh/package.json'), '../lib/bin.js');
const child = spawn(process.execPath, [bin, '--profile', 'model-config-fixture'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: join(home, 'harness'),
    MODEL_CONFIGURATION_FIXTURE_KEY: 'fixture-secret-value',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});
const timer = preview ? undefined : setTimeout(() => child.kill(), audit ? 180000 : 40000);
process.once('SIGTERM', () => child.kill());
process.once('SIGINT', () => child.kill());
try {
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, output);
  if (!preview) {
    assert.ok(output.includes('MODEL_CONFIG_RUNTIME_OK'), output);
    assert.ok(fixture.calls.some((c) => c.model === 'fixture-second' && c.stream));
    assert.ok(fixture.calls.some((c) => c.model === 'fixture-updated' && c.stream));
    if (process.platform === 'win32') {
      const env = { ...process.env };
      delete env.MODEL_CONFIGURATION_NEW_KEY;
      const restarted = spawn(
        process.execPath,
        ['bin/emergence.cjs', cwd, '--home', home, '--model', 'key-test', '--print', 'hello'],
        { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      let result = '',
        errors = '';
      restarted.stdout.on('data', (chunk) => (result += chunk));
      restarted.stderr.on('data', (chunk) => (errors += chunk));
      const restartTimer = setTimeout(() => restarted.kill(), 30000);
      const restartCode = await new Promise<number | null>((resolve) => restarted.once('exit', resolve));
      clearTimeout(restartTimer);
      assert.equal(restartCode, 0, errors);
      assert.ok(result.includes('CONFIG_REPLY:fixture-key-rotated'));
      assert.ok(!result.includes('rotated-fixture-secret'));
    }
    const evidence = {
      passed: true,
      root,
      crossProcessEncryptedCredential: process.platform === 'win32',
      calls: fixture.calls,
      audit: audit
        ? (JSON.parse(await readFile(join(home, 'audit-result.json'), 'utf8')) as unknown)
        : undefined,
    };
    await writeFile(
      join(parent, audit ? 'audit-runtime.json' : 'runtime-result.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(
      'Verified actual Harness hot routes, session history, window assignment, defaults and hidden panes.',
    );
  }
} finally {
  clearTimeout(timer);
  child.kill();
  await fixture.close();
}
