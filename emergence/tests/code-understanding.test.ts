import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { nativeReadEvidence } from '../src/core/application/native-read-evidence.ts';
import { evidenceIsCurrent } from '../src/core/application/tool-evidence.ts';
import { codeLimits, hostExecutable, hostProcess, scanProject } from '../src/domains/code/project.ts';
import { codeQuery } from '../src/domains/code/service.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

async function seed(root: string) {
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      packageManager: 'npm@10',
      workspaces: ['packages/*'],
      scripts: { test: 'node --test', build: 'tsc' },
    }),
  );
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'EMERGENCE.md'), '本项目保留已有改动，测试通过后交付。');
  await writeFile(
    join(root, 'src/calc.ts'),
    'export function computeRevenue(price: number) {\r\n  return price * 2;\r\n}\r\n',
  );
  await writeFile(
    join(root, 'src/main.ts'),
    "import { computeRevenue } from './calc';\nexport const total = computeRevenue(3);\n",
  );
  await writeFile(
    join(root, 'tests/calc.test.ts'),
    "import { computeRevenue } from '../src/calc';\nexport const verified = computeRevenue(1) === 2;\n",
  );
}
const signal = () => new AbortController().signal;

test('bundled ignore-aware scanner works without PATH tools or a Git repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-bundled-scan-'));
  const previous = process.env.PATH;
  try {
    await seed(root);
    await writeFile(join(root, '.gitignore'), 'private.ts\n');
    await writeFile(join(root, 'private.ts'), 'secret');
    process.env.PATH = '';
    const snapshot = await scanProject(root, signal());
    assert.equal(snapshot.scanner, 'rg');
    assert.equal(snapshot.truncated, false);
    assert.ok(snapshot.paths.includes('src/main.ts'));
    assert.ok(!snapshot.paths.includes('private.ts'));
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('project profile observes configuration, workspace, guidance and actual dirty Git status without running scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-code-profile-'));
  try {
    await seed(root);
    const git = await hostExecutable('git', root);
    if (git) await hostProcess(git, ['init', '--quiet'], root, signal());
    const result = await codeQuery('emergence_code_project', root, '', signal());
    assert.equal(result.profile?.packages[0].name, 'fixture');
    assert.deepEqual(result.profile?.packages[0].workspaces, ['packages/*']);
    assert.ok(result.profile?.configs.includes('EMERGENCE.md'));
    assert.ok(result.profile?.configs.includes('package-lock.json'));
    assert.ok(result.profile?.languages['.ts']);
    if (git) assert.equal(result.profile?.git.state, 'dirty');
    assert.ok(nativeReadEvidence(result).some((f) => f.path.endsWith('package.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('actual compaction keeps Code pointers available without copying the entire repository into the prompt', async () => {
  const f = await executionFixture();
  try {
    await seed(f.cwd);
    await f.ctx.plugin(TokenMeter);
    await f.ctx.plugin(BasicCompaction, {
      thresholdRatio: 0.95,
      headroomTokens: 0,
      maxTokens: 128,
      retainTokens: 64,
    });
    let first = true;
    const captured: string[] = [];
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      captured.push(JSON.stringify(options));
      if (first) {
        first = false;
        const id = ToolCallId('compact-code'),
          name = 'emergence_code_context',
          raw = '{"query":"computeRevenue"}';
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const text = 'CODE_SUMMARY 保留目标、未决问题与权限。' + '历史背景 '.repeat(100);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const c = f.w.current.controller!;
    await f.w.send(f.w.focused, '定位 computeRevenue');
    await c.agent.whenIdle();
    for (let i = 0; i < 5; i++) {
      await f.w.send(f.w.focused, '继续讨论，未决问题保持不变 ' + '背景说明 '.repeat(80));
      await c.agent.whenIdle();
    }
    assert.ok(await f.ctx.compaction.compactNow(c.agent, AbortSignal.timeout(10000)));
    assert.ok(c.agent.session.snapshotEvents().some((e) => e.type === 'compaction/end'));
    await f.w.send(f.w.focused, '压缩后继续定位');
    await c.agent.whenIdle();
    assert.ok(captured.at(-1)!.includes('代码定位恢复指针'));
    assert.ok(captured.at(-1)!.includes('src/calc.ts'));
    assert.ok((await c.code.recall(c.agent)).length < 3600);
    await f.w.send(f.w.focused, '什么是递归？');
    await c.agent.whenIdle();
    assert.equal(await c.code.recall(c.agent), '');
  } finally {
    await f.close();
  }
});

test('project and Python results survive the real lossless-JSON tool protocol', async () => {
  const f = await executionFixture();
  try {
    await seed(f.cwd);
    await writeFile(
      join(f.cwd, 'src/revenue.py'),
      'from missing_library import helper\ndef compute_revenue(x):\n    return helper(x)\n',
    );
    let step = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (step >= 2) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const n = step++,
        name = n ? 'emergence_code_context' : 'emergence_code_project';
      const id = ToolCallId('json-code-' + n),
        raw = JSON.stringify(n ? { query: 'compute_revenue' } : {});
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const c = f.w.current.controller!;
    c.setPermissionMode('plan');
    await f.w.send(f.w.focused, '定位 compute_revenue');
    await c.agent.whenIdle();
    const results = c.agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
    assert.equal(results.length, 2);
    for (const event of results)
      assert.equal(event.data.message.isError, false, JSON.stringify(event.data.message));
    assert.match(c.transcript().join('\n'), /python-ast-name-hint/);
  } finally {
    await f.close();
  }
});

test('TS language service resolves implementation, real references and tests; edits invalidate the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-code-ts-'));
  try {
    await seed(root);
    const result = await codeQuery('emergence_code_context', root, 'computeRevenue', signal());
    assert.ok(result.hits.some((h) => h.path === 'src/calc.ts' && h.kind === 'definition' && h.line === 1));
    assert.ok(
      result.hits.some((h) => h.path === 'src/main.ts' && h.method === 'typescript-semantic' && h.line === 2),
    );
    assert.ok(result.hits.some((h) => h.path === 'tests/calc.test.ts' && h.method === 'typescript-semantic'));
    assert.ok(result.relationships.some((r) => r.path === 'src/main.ts' && r.target === 'src/calc.ts'));
    assert.ok(result.snippets.some((s) => s.path === 'tests/calc.test.ts'));
    await writeFile(join(root, 'src/calc.ts'), 'export function differentFunction() { return 42; }\n');
    const next = await codeQuery('emergence_code_locate', root, 'computeRevenue', signal());
    assert.notEqual(next.version, result.version);
    assert.ok(!next.hits.some((h) => h.path === 'src/calc.ts' && h.kind === 'definition'));
    assert.ok(!next.hits.some((h) => h.path === 'src/main.ts' && h.method === 'typescript-semantic'));
    await writeFile(join(root, 'src/value.mjs'), 'export function calculateTotal(x) { return x + 1; }\n');
    await writeFile(
      join(root, 'src/caller.mjs'),
      "import { calculateTotal } from './value.mjs';\nexport const value = calculateTotal(3);\n",
    );
    const js = await codeQuery('emergence_code_locate', root, 'calculateTotal', signal());
    assert.ok(
      js.hits.some((h) => h.path === 'src/caller.mjs' && h.method === 'typescript-semantic' && h.line === 2),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Python AST locates definitions and import hints without executing project modules, with explicit text fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-code-python-'));
  try {
    await writeFile(
      join(root, 'calc.py'),
      "raise RuntimeError('MUST_NOT_EXECUTE')\ndef compute_revenue(amount):\n    return amount * 2\n",
    );
    await writeFile(join(root, 'main.py'), 'from calc import compute_revenue\ntotal = compute_revenue(3)\n');
    const result = await codeQuery('emergence_code_locate', root, 'compute_revenue', signal());
    assert.ok(
      result.services.some((s) => s.includes('Python AST')),
      JSON.stringify(result.warnings),
    );
    assert.ok(result.hits.some((h) => h.path === 'calc.py' && h.kind === 'definition' && h.line === 2));
    assert.ok(result.relationships.some((r) => r.path === 'main.py' && r.target === 'calc.py'));
    const fallback = await codeQuery(
      'emergence_code_locate',
      root,
      'compute_revenue',
      signal(),
      undefined,
      true,
    );
    assert.ok(fallback.hits.every((h) => h.method === 'text-match'));
    assert.ok(fallback.warnings.some((w) => w.includes('文本')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded discovery excludes links, dependencies, ignored and denied content; cancellation is propagated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-code-boundary-')),
    external = await mkdtemp(join(tmpdir(), 'emergence-code-outside-'));
  try {
    await seed(root);
    await writeFile(join(external, 'secret.ts'), 'const OUTSIDE_SECRET = 1');
    await symlink(external, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules/hidden.ts'), 'const DEPENDENCY_SECRET = 1');
    await writeFile(join(root, '.env'), 'SECRET=private');
    await writeFile(join(root, '.gitignore'), 'private.ts\n');
    await writeFile(join(root, 'private.ts'), 'const PRIVATE = 1');
    const snapshot = await scanProject(root, signal(), undefined, (path) => !path.endsWith('main.ts'));
    assert.ok(!snapshot.files.some((f) => /secret|hidden|main\.ts|\.env|private\.ts/.test(f.relative)));
    await assert.rejects(
      codeQuery('emergence_code_locate', root, 'secret', signal(), '../outside.ts'),
      /超出/,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(codeQuery('emergence_code_project', root, '', cancelled.signal), /abort/i);
    for (let i = 0; i < 270; i++)
      await writeFile(join(root, `f${i}.ts`), `export const repeated_${i} = ${i};\n`);
    const result = await codeQuery('emergence_code_context', root, 'repeated', signal());
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= codeLimits.outputBytes);
    assert.ok(result.hits.length <= codeLimits.matches);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('real Harness exposes native Code tools in Plan, persists versioned evidence, restores pointers and rejects stale/cross-project context', async () => {
  const f = await executionFixture();
  let restored: WorkspaceController | undefined;
  try {
    await seed(f.cwd);
    let step = 0;
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      if (step++ === 0) {
        assert.ok(options.tools?.some((t) => t.name === 'emergence_code_context'));
        const id = ToolCallId('native-code'),
          name = 'emergence_code_context',
          raw = JSON.stringify({ query: 'computeRevenue' });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (step === 2) {
        const id = ToolCallId('report-code'),
          name = 'emergence_report',
          raw = JSON.stringify({ outcome: 'success', summary: '找到实现和调用方，未执行项目代码' });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const master = f.w.current,
      worker = await f.w.split('row');
    f.w.collaboration.configure(master.id, [worker.id]);
    worker.controller!.setPermissionMode('plan');
    const task = await f.w.collaboration.enqueue(
      master.id,
      worker.id,
      'code-discovery',
      '定位 computeRevenue 的实现和调用方',
      [],
      { role: 'researcher', scope: ['src', 'tests'], acceptance: ['源码位置与版本明确'] },
    );
    await until(() => ['needs_review', 'failed', 'succeeded'].includes(task.status));
    assert.ok(task.receipts.length, worker.controller!.transcript().join('\n'));
    const receipt = task.receipts.find((r) => r.tool === 'emergence_code_context')!;
    assert.equal(receipt.ok, true);
    assert.equal(receipt.kind, 'read');
    assert.ok(
      receipt.manifest!.inputs.some((f) => f.path.endsWith('calc.ts')),
      JSON.stringify(receipt),
    );
    const prior = await worker.controller!.code.recall(worker.controller!.agent);
    assert.match(prior, /src\/calc.ts/);
    await f.w.save();
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    const pane = [...restored.panes.values()].find((p) => p.sessionId === task.targetSession)!;
    assert.match(await pane.controller!.code.recall(pane.controller!.agent), /computeRevenue/);
    await writeFile(join(f.cwd, 'src/calc.ts'), 'export const changed = 1;');
    assert.equal(await evidenceIsCurrent(receipt), false);
    const recalled = await pane.controller!.code.recall(pane.controller!.agent);
    assert.match(recalled, /invalidated/);
    assert.ok(!recalled.includes('return price * 2'));
    const other = join(f.home, 'other');
    await mkdir(other);
    await f.ctx.workingDirectory.set(pane.controller!.agent, other);
    assert.equal(await pane.controller!.code.recall(pane.controller!.agent), '');
  } finally {
    await restored?.close();
    await f.close();
  }
});
