import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveConfig } from '../src/app/config.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';

const parent = resolve('../artifacts/r4');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'http-'));
const results: object[] = [];
for (const scenario of [
  '500',
  '429',
  'stream',
  'malformed',
  'malformed-exhausted',
  'schema',
  'schema-exhausted',
  '401',
]) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      /* Drain fixture request; never save prompts or headers. */
    }
    requests++;
    if (scenario === '401' || (requests === 1 && ['500', '429'].includes(scenario))) {
      response.writeHead(Number(scenario), { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'controlled fixture failure', type: 'fixture_error' } }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: object, finish: string | null = null) =>
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'r4-http',
            object: 'chat.completion.chunk',
            model: 'fixture-model',
            created: 1,
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          '\n\n',
      );
    emit({ role: 'assistant' });
    if (scenario.endsWith('-exhausted') || (['malformed', 'schema'].includes(scenario) && requests === 1)) {
      // A completed first block must also be discarded when a later block is invalid.
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'discarded-complete',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ file_path: 'unexpected.txt', content: 'must never execute' }),
            },
          },
          {
            index: 1,
            id: 'malformed-report',
            type: 'function',
            function: scenario.startsWith('schema')
              ? {
                  name: 'pwsh',
                  arguments: JSON.stringify({ description: 'List project files', workdir: '.' }),
                }
              : { name: 'emergence_report', arguments: '{"summary":"bad " quote"}' },
          },
        ],
      });
      emit({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
      return;
    }
    if (scenario === 'stream' && requests === 1) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'unfinished',
            type: 'function',
            function: { name: 'write', arguments: '{"file_path":' },
          },
        ],
      });
      response.end();
      return;
    }
    emit({ content: 'R4_HTTP_RECOVERED' });
    emit({}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const home = join(root, scenario, 'home'),
    project = join(root, scenario, 'project');
  await mkdir(project, { recursive: true });
  const config = structuredClone(defaultConfig);
  config.models = [
    {
      ...config.models[0],
      api: 'openai-completions',
      model: 'fixture-model',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'R4_HTTP_FIXTURE_KEY',
    },
  ];
  await saveConfig(home, config);
  const child = spawn(
    process.execPath,
    ['bin/emergence.cjs', project, '--home', home, '--print', '你好，回复一句话即可'],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, R4_HTTP_FIXTURE_KEY: 'local-fixture-only' },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const deadline = setTimeout(() => child.kill(), 40000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('exit', done);
      child.once('error', reject);
    });
    const events = (
      await Promise.all(
        (await readdir(join(home, 'sessions'), { recursive: true }))
          .filter((path) => path.endsWith('.jsonl'))
          .map(async (path) =>
            (await readFile(join(home, 'sessions', path), 'utf8'))
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          ),
      )
    ).flat();
    const retries = events.filter((e) => e.type === 'llm/retry');
    results.push({
      scenario,
      code,
      requests,
      retries: retries.map((e) => ({ code: e.data.failure.code, retry: e.data.retry })),
    });
    const exhausted = scenario.endsWith('-exhausted');
    assert.equal(requests, scenario === '401' ? 1 : exhausted ? 3 : 2, JSON.stringify(results));
    assert.equal(retries.length, scenario === '401' ? 0 : exhausted ? 2 : 1, JSON.stringify(results));
    if (scenario.startsWith('malformed') || scenario.startsWith('schema'))
      assert.ok(retries.every((e) => e.data.failure.code === 'MALFORMED_RESPONSE'));
    if (scenario !== '401' && !exhausted) {
      assert.equal(code, 0, output.slice(-2000));
      assert.ok(output.includes('R4_HTTP_RECOVERED'), output.slice(-2000));
    } else {
      assert.ok(!output.includes('R4_HTTP_RECOVERED'));
      assert.equal(events.filter((e) => e.type === 'turn/end' && e.data.reason.kind === 'error').length, 1);
    }
    assert.equal(events.filter((e) => e.type === 'tool/call').length, 0, 'invalid response never executes');
    assert.equal(
      events.filter((e) => e.type === 'approval/asked').length,
      0,
      'invalid input never asks permission',
    );
    assert.deepEqual(await readdir(project), [], 'fixture never writes user project files');
  } finally {
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await writeFile(join(root, 'result.json'), JSON.stringify(results, null, 2));
  }
}
console.log(JSON.stringify({ root, results }, null, 2));
