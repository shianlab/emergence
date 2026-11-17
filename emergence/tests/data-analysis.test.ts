import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { captureToolEvidence, evidenceIsCurrent } from '../src/core/application/tool-evidence.ts';
import { Definitions, definitionSchema } from '../src/domains/data/definitions.ts';
import { analyzeData, dataRuntime } from '../src/domains/data/service.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-analysis-')),
    root = join(home, '项目');
  await mkdir(root);
  await writeFile(join(root, 'data.csv'), 'id,amount\n001,12.50\n002,7.50\n');
  return { home, root };
}
const signal = () => AbortSignal.timeout(30000);

test('quality facts distinguish blanks from nulls and appear in exported reports without rewriting inputs', async () => {
  const f = await fixture();
  const source = 'id,note\r\n001,  \r\n001,  \r\n002,\r\n';
  await writeFile(join(f.root, 'quality.csv'), source);
  const result = await analyzeData(
    f.root,
    f.home,
    { file_path: 'quality.csv', method: 'clean', params: {} },
    signal(),
  );
  assert.equal(result.rows, 3);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.columns[1].missing, 1);
  assert.equal(result.columns[1].blankText, 2);
  assert.equal(result.analysis.table.length, 3);
  assert.equal(result.analysis.table[0].note, '  ');
  assert.equal(await readFile(join(f.root, 'quality.csv'), 'utf8'), source);
  for (const file of ['report.html', 'report.md']) {
    const report = await readFile(join(result.artifact, file), 'utf8');
    assert.match(report, /输入质量与范围/);
    assert.match(report, /重复行 1/);
    assert.match(report, /空值 1，空白文本 2/);
  }
});
test('all eight published methods pass independent expected values and counterexamples', async () => {
  const runtime = await dataRuntime();
  execFileSync(runtime.python, ['-I', resolve('tests/fixtures/data-analysis-cases.py')], {
    timeout: 30000,
    stdio: 'pipe',
  });
});

test('method discovery remains available while business questions block execution', async () => {
  const f = await executionFixture();
  try {
    let step = 0;
    const calls = [
      [
        'emergence_analyze',
        {
          objective: '分析收入',
          reason: '业务口径待定',
          route: 'focused',
          intent: 'clarify',
          questions: ['收入采用何种确认口径？'],
        },
      ],
      ['emergence_data_methods', { method: 'attribution' }],
      ['emergence_data_analyze', { file_path: 'data.csv', method: 'attribution', params_json: '{}' }],
    ] as const;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      const call = calls[step++];
      if (!call) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const [name, args] = call,
        id = ToolCallId('data-discovery-' + step),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(f.w.focused, '先讨论收入的分析口径');
    const agent = f.w.current.controller!.agent;
    await agent.whenIdle();
    const events = agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
    const discovery = events.find((e) => e.data.message.toolCallId === 'data-discovery-2');
    const analysis = events.find((e) => e.data.message.toolCallId === 'data-discovery-3');
    assert.ok(discovery && !discovery.data.message.isError);
    assert.ok(analysis?.data.message.isError);
    assert.match(JSON.stringify(analysis), /需要用户决定|待澄清|讨论/);
  } finally {
    await f.close();
  }
});
test('actual native analysis produces CSV, safe Chinese HTML, exact proof and replayable snapshot', async () => {
  const f = await fixture();
  let receipt: any;
  const result = await captureToolEvidence(
    {
      callId: 'analysis',
      name: 'emergence_data_analyze',
      arguments: { file_path: 'data.csv' },
      cwd: f.root,
      taskId: 'task',
      sessionId: 'session',
      signal: signal(),
    },
    async () => ({
      isError: false,
      value: await analyzeData(
        f.root,
        f.home,
        { file_path: 'data.csv', method: 'metric', params: { value: 'amount', mode: 'sum' } },
        signal(),
      ),
    }),
    async (r) => {
      receipt = r;
    },
  );
  const data = result.value;
  assert.equal(data.analysis.table[0].value, '20.00');
  assert.equal(data.definition.status, 'assumed');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.kind, 'command');
  assert.ok(receipt.manifest.outputs.length >= 10);
  assert.equal(await evidenceIsCurrent(receipt), true);
  const html = await readFile(join(data.artifact, 'report.html'), 'utf8');
  assert.ok(html.includes('涌现'));
  assert.ok(html.includes('20.00'));
  assert.ok(!html.includes('<script'));
  const runtime = await dataRuntime();
  execFileSync(runtime.python, ['-I', join(data.artifact, 'replay.py')], { timeout: 30000, stdio: 'pipe' });
  await writeFile(join(data.artifact, 'table.csv'), 'tampered');
  assert.equal(await evidenceIsCurrent(receipt), false);
  assert.equal(await readFile(join(f.root, 'data.csv'), 'utf8'), 'id,amount\n001,12.50\n002,7.50\n');
});
test('reports escape executable HTML and spreadsheet formulas; unconfirmed facts cannot acquire confirmed status', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'data.csv'), 'id,value\n"<script>alert(1)</script>","=1+1"\n');
  const result = await analyzeData(
    f.root,
    f.home,
    { file_path: 'data.csv', method: 'clean', params: {} },
    signal(),
  );
  assert.ok((await readFile(join(result.artifact, 'report.html'), 'utf8')).includes('&lt;script&gt;'));
  assert.ok((await readFile(join(result.artifact, 'table.csv'), 'utf8')).includes("'=1+1"));
  await assert.rejects(
    analyzeData(
      f.root,
      f.home,
      { file_path: 'data.csv', method: 'clean', params: {}, definition: { status: 'user-confirmed' } },
      signal(),
    ),
  );
  await writeFile(join(f.root, 'data.csv'), 'amount\n9007199254740993\n');
  const large = await analyzeData(
    f.root,
    f.home,
    { file_path: 'data.csv', method: 'metric', params: { value: 'amount' } },
    signal(),
  );
  assert.ok(
    (await readFile(join(large.artifact, 'chart.svg'), 'utf8')).includes('9007199254740993'),
    '图表数值标签保留原始精确值，不能经过 Number 丢失整数精度',
  );
});
test('project definitions require real approval, bind parameters, resist stale edits, and isolate projects', async () => {
  const f = await fixture(),
    store = new Definitions(f.home, f.root);
  const definition = definitionSchema.parse({
    name: '收入',
    method: 'metric',
    params: { value: 'amount' },
    formula: 'sum(amount)',
    grain: '每行一次收入',
    numerator: 'amount',
    denominator: '无',
    filters: '无',
    timezone: 'UTC',
    unit: '元',
    source: 'data.csv',
    assumptions: [],
  });
  await assert.rejects(
    store.save(definition, null, async () => false),
    /取消/,
  );
  assert.equal(await store.get('收入'), null);
  const first = await store.save(definition, null, async () => true);
  assert.equal(first.status, 'user-confirmed');
  await assert.rejects(
    store.save({ ...definition, unit: '美元' }, null, async () => true),
    /其他窗口/,
  );
  const result = await analyzeData(
    f.root,
    f.home,
    { file_path: 'data.csv', method: 'metric', params: { value: 'amount' }, definition_name: '收入' },
    signal(),
  );
  assert.equal(result.definition.version, first.version);
  await assert.rejects(
    analyzeData(
      f.root,
      f.home,
      {
        file_path: 'data.csv',
        method: 'metric',
        params: { value: 'amount', mode: 'ratio' },
        definition_name: '收入',
      },
      signal(),
    ),
    /不一致/,
  );
  assert.equal(await new Definitions(f.home, f.home).get('收入'), null);
  let receipt: any;
  await captureToolEvidence(
    {
      callId: 'confirmed-definition',
      name: 'emergence_data_analyze',
      arguments: { file_path: 'data.csv' },
      cwd: f.root,
      taskId: 'task',
      sessionId: 'session',
      signal: signal(),
    },
    async () => ({
      isError: false,
      value: await analyzeData(
        f.root,
        f.home,
        { file_path: 'data.csv', method: 'metric', params: { value: 'amount' }, definition_name: '收入' },
        signal(),
      ),
    }),
    async (r) => {
      receipt = r;
    },
  );
  assert.equal(await evidenceIsCurrent(receipt), true);
  await store.save({ ...definition, unit: '美元' }, first.version, async () => true);
  assert.equal(await evidenceIsCurrent(receipt), false, '确认口径变化后，旧分析证据必须失效');
});
test('actual assigned Harness task returns computational receipts with tracked artifacts and independent task version invalidation', async () => {
  const f = await executionFixture();
  try {
    await writeFile(join(f.cwd, 'data.csv'), 'id,amount\n001,12.50\n002,7.50\n');
    await f.w.split('row');
    const worker = f.w.current;
    let step = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      const seq = [
        [
          'emergence_data_analyze',
          { file_path: 'data.csv', method: 'metric', params_json: '{"value":"amount"}' },
        ],
        ['emergence_report', { outcome: 'success', summary: '总和20，实际双路复算' }],
      ] as const;
      const call = seq[step++];
      if (!call) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const [name, args] = call,
        id = ToolCallId('analysis-' + step),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'analyze', '汇总数据');
    await until(() => ['succeeded', 'needs_review', 'failed'].includes(task.status));
    assert.equal(task.result?.errors.length, 0, JSON.stringify(task.result));
    const receipt = task.receipts.find((r) => r.tool === 'emergence_data_analyze')!;
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.manifest!.outputs.length > 0);
    await f.w.taskEngine.assurance.version(task);
    await writeFile(receipt.manifest!.outputs.find((r) => r.path.endsWith('table.csv'))!.path, 'tampered');
    await assert.rejects(f.w.taskEngine.assurance.version(task), /失效/);
  } finally {
    await f.close();
  }
});

test('native data receipts support explicit acceptance without shell permission expansion', async () => {
  const f = await executionFixture();
  try {
    const FileTools = await import('@deepseek-ai/dsh-tool-fs');
    const Approval = (await import('@deepseek-ai/dsh-user-approval')).default;
    await f.ctx.plugin(FileTools, { write: false, edit: false, readImage: false });
    await f.ctx.plugin(Approval);
    await writeFile(join(f.cwd, 'data.csv'), 'id,amount\n001,12.50\n002,7.50\n');
    const worker = await f.w.split('row');
    const positions = new Map<string, number>();
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      const text = options.messages
        .filter((m) => m.role === 'user')
        .map((m) => JSON.stringify(m.content))
        .findLast((t) => t.includes('[Emergence task '));
      const taskId = text?.match(/\[Emergence task ([^\]]+)\]/)?.[1];
      const task = f.w.taskEngine.state.tasks.find((t) => t.id === taskId);
      if (!task) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const step = positions.get(task.id) ?? 0;
      positions.set(task.id, step + 1);
      const audit = task.assessment;
      const sequence = audit
        ? [
            audit.kind === 'review' ? 'read' : 'emergence_data_analyze',
            'emergence_assess',
            'emergence_report',
          ]
        : ['emergence_data_analyze', 'emergence_report'];
      const name = sequence[step];
      if (!name) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const args =
        name === 'read'
          ? { file_path: 'data.csv' }
          : name === 'emergence_data_analyze'
            ? { file_path: 'data.csv', method: 'metric', params_json: '{"value":"amount"}' }
            : name === 'emergence_assess'
              ? {
                  checks: [
                    {
                      criterion: 0,
                      passed: true,
                      receipts: [`data-${task.id}-0`],
                      note: '独立读取或重新执行，核对总和20与缺失口径',
                    },
                  ],
                }
              : { outcome: 'success', summary: '数据实际核验完成' };
      const id = ToolCallId(`data-${task.id}-${step}`),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const subject = await f.w.taskEngine.enqueue(worker.id, worker.id, 'data-subject', '实际计算总和20', [], {
      role: 'developer',
      scope: ['data.csv'],
      acceptance: ['amount总和20且执行成功'],
    });
    await until(() => subject.status === 'needs_review');
    assert.ok(subject.receipts.some((r) => r.tool === 'emergence_data_analyze' && r.ok && r.exitCode === 0));
    assert.ok(!subject.receipts.some((r) => ['pwsh', 'bash'].includes(r.tool)));
    assert.equal((await f.w.taskEngine.assurance.status(subject.id)).verification, false);
    await assert.rejects(
      f.w.taskEngine.review(subject.id, true, '模型声明不是独立验证', 'model'),
      /审查|验证/,
    );
    await f.w.taskEngine.review(subject.id, true, '用户已核对原生计算产物');
    assert.equal(subject.status, 'succeeded');
  } finally {
    await f.close();
  }
});
