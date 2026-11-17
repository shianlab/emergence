import { digest } from '../src/core/storage/execution-journal.ts';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { dataRuntime } from '../src/domains/data/service.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

async function* call(name: string, args: unknown, id: string): AsyncIterable<StreamChunk> {
  const key = ToolCallId(id),
    raw = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: key, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: key, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
async function waitFor(predicate: () => boolean, limit = 30000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('mixed acceptance timed out');
}

test('single-session native KIM plan repairs Python then computes data after evidence acceptance', async () => {
  const f = await executionFixture();
  f.config.core.planning.submission = 'whole';
  f.w.current.controller!.launch.appConfig.core.planning.submission = 'whole';
  try {
    await f.ctx.plugin(UserApproval);
    await f.ctx.plugin(FileTools, { write: false, edit: false, readImage: false });
    const root = f.w.current;
    await f.w.split('row');
    const fixed =
      "import csv\nfrom pathlib import Path\nvalues=[int(r['amount']) for r in csv.DictReader(Path('raw.csv').open())]\ntotal=sum(values)\nassert total==8\nPath('clean.csv').write_text('amount\\n'+str(total)+'\\n')\nprint('VERIFIED 8')\n";
    await writeFile(join(f.cwd, 'prepare.py'), fixed.replace('sum(values)', 'sum(abs(v) for v in values)'));
    await writeFile(join(f.cwd, 'raw.csv'), 'amount\n10\n-2\n');
    await writeFile(join(f.cwd, 'clean.csv'), 'amount\n12\n');
    await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'python prepare.py' } }));
    const runtime = await dataRuntime();
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'pwsh',
          description: 'fixed Python acceptance process',
          parameters: { command: { type: 'string', required: true } },
          output: {
            schema: { type: 'json' },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
          },
          execute: async (args, exec) => {
            assert.equal(args.command, 'npm run test');
            try {
              const r = await promisify(execFile)(runtime.python, ['-I', 'prepare.py'], {
                cwd: f.ctx.workingDirectory.get(exec.agent!.session),
                windowsHide: true,
                signal: exec.signal,
              });
              return { exitCode: 0, stdout: r.stdout };
            } catch (e) {
              return { exitCode: 1, stdout: String(e) };
            }
          },
        }),
      ),
    );
    const positions = new Map<string, number>();
    let master = 0;
    f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
      const messages = request.messages.map((m) => ({
        role: m.role,
        text: m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
      }));
      const incoming = messages.findLast((m) => m.role === 'user' && m.text.startsWith('[Emergence task '));
      if (incoming) {
        const id = incoming.text.match(/\[Emergence task ([^\]]+)\]/)![1],
          t = f.w.taskEngine.task(id),
          n = positions.get(id) ?? 0;
        positions.set(id, n + 1);
        const data = t.workflow?.step === 'analyze';
        {
          const sequence = data
            ? [
                [
                  'emergence_data_analyze',
                  { file_path: 'clean.csv', method: 'metric', params_json: '{"value":"amount"}' },
                ],
                ['emergence_report', { outcome: 'success', summary: '真实合计8' }],
              ]
            : [
                ['emergence_code_work', { action: 'begin' }],
                ['pwsh', { command: 'npm run test' }],
                ['read', { file_path: 'prepare.py' }],
                ['write', { file_path: 'prepare.py', content: fixed }],
                ['pwsh', { command: 'npm run test' }],
                ['pwsh', { command: 'npm run test' }],
                [
                  'emergence_report',
                  {
                    outcome: 'success',
                    summary: '修复退款计算并生成clean.csv',
                    artifacts: ['prepare.py', 'clean.csv'],
                  },
                ],
              ];
          if (sequence[n]) yield* call(String(sequence[n][0]), sequence[n][1], id + '-' + n);
          else yield { type: 'finish', reason: { kind: 'stop' } };
        }
        return;
      }
      const n = master++;
      if (n === 0)
        yield* call(
          'emergence_analyze',
          {
            objective: '修复退款计算并分析数据',
            reason: '代码与数据有依赖，需要独立验收',
            route: 'planned',
            intent: 'execute',
            acceptance: ['合计8'],
            constraints: ['保留退款负数', '不改原始raw.csv'],
          },
          'mixed-intake',
        );
      else if (n === 1) yield* call('read', { file_path: 'prepare.py' }, 'mixed-read');
      else if (n === 2)
        yield* call(
          'emergence_plan',
          {
            plan: {
              requirementRevision: root.controller!.planning.intake()!.requirements!.revision,
              unknowns: [],
              assumptions: [],
              options: [],
              reason: '先修复再计算',
              evidence: ['mixed-read'],
              steps: [
                {
                  id: 'prepare',
                  window: root.id,
                  session: root.controller!.id,
                  project: root.cwd,
                  model: root.modelId,
                  objective: '修复prepare.py并运行现有测试生成clean.csv',
                  role: 'developer',
                  scope: ['prepare.py', 'raw.csv', 'clean.csv', 'package.json'],
                  capabilities: ['tool:read', 'tool:write', 'tool:pwsh'],
                  requirementIds: ['a1'],
                  purpose: 'delivery',
                  dependsOn: [],
                },
                {
                  id: 'analyze',
                  window: root.id,
                  session: root.controller!.id,
                  project: root.cwd,
                  model: root.modelId,
                  objective: '计算clean.csv合计并交付报告',
                  role: 'developer',
                  scope: ['clean.csv'],
                  capabilities: ['tool:emergence_data_analyze'],
                  requirementIds: ['a1'],
                  purpose: 'delivery',
                  dependsOn: ['prepare'],
                },
              ],
            },
          },
          'mixed-plan',
        );
      else if (n === 3)
        yield* call(
          'emergence_execute_plan',
          { plan_id: digest(root.controller!.planning.snapshot(root.controller!.agent)!.plan!) },
          'mixed-execute',
        );
      else yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(root.id, '修复退款被转正的问题，生成数据后计算收入并交付报告。');
    await waitFor(() => {
      if (root.controller?.pending) root.controller.pending.respond('y');
      return f.w.taskEngine.state.tasks[0]?.status === 'needs_review';
    });
    const first = f.w.taskEngine.state.tasks[0];
    assert.equal(first.result?.code?.verified, true, JSON.stringify(first.result));
    assert.equal(f.w.taskEngine.state.tasks[1].status, 'queued');
    await f.w.taskEngine.review(first.id, true, '已核对真实 Python 检查与输出文件');
    await waitFor(() => f.w.taskEngine.state.tasks[1]?.status === 'needs_review');
    const second = f.w.taskEngine.state.tasks[1];
    assert.ok(second.receipts.some((r) => r.tool === 'emergence_data_analyze' && r.ok));
    await f.w.taskEngine.review(second.id, true, '已核对实际数据计算回执与原始输入');
    const tasks = f.w.taskEngine.state.tasks,
      code = tasks.find((t) => t.workflow?.step === 'prepare' && !t.assessment)!,
      data = tasks.find((t) => t.workflow?.step === 'analyze' && !t.assessment)!;
    assert.ok(data.startedAt! >= code.review!.at);
    assert.equal(code.result?.code?.verified, true);
    const deliveries = f.w.taskEngine.assurance.dataDeliveries(data);
    assert.ok(deliveries.runs[0].files.some((v) => v.path.endsWith('report.html')));
    assert.equal(await readFile(join(f.cwd, 'raw.csv'), 'utf8'), 'amount\n10\n-2\n');
    assert.equal(
      await readFile(join(f.cwd, 'clean.csv'), 'utf8'),
      process.platform === 'win32' ? 'amount\r\n8\r\n' : 'amount\n8\n',
    );
    assert.ok(tasks.every((t) => t.status === 'succeeded' && !t.assessment));
  } finally {
    await f.close();
  }
});

test('a downstream task refuses stale native data inputs even when no artifacts were model-reported', async () => {
  const f = await executionFixture();
  try {
    await writeFile(join(f.cwd, 'data.csv'), 'amount\n10\n');
    const worker = await f.w.split('row');
    let step = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (step++ === 0)
        yield* call(
          'emergence_data_analyze',
          { file_path: 'data.csv', method: 'metric', params_json: '{"value":"amount"}' },
          'source-analysis',
        );
      else if (step === 2)
        yield* call('emergence_report', { outcome: 'success', summary: 'computed' }, 'source-report');
      else yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'source', '计算合计');
    await until(() => task.status === 'succeeded');
    await worker.controller!.agent.whenIdle();
    assert.equal(task.artifactVersions.length, 0);
    await writeFile(join(f.cwd, 'data.csv'), 'amount\n999\n');
    const next = await f.w.taskEngine.enqueue(worker.id, worker.id, 'consumer', '基于上一分析继续', [
      task.id,
    ]);
    await until(() => next.status === 'blocked');
    assert.match(next.progress, /依赖输入|口径|产物/);
    assert.equal(next.receipts.length, 0, 'stale dependency must not execute tools');
    assert.equal(next.result?.fromSeq, next.result?.toSeq);
  } finally {
    await f.close();
  }
});

test('fresh idle windows publish Code/Data capabilities and existing deny rules disable only that domain', async () => {
  const f = await executionFixture();
  try {
    const worker = await f.w.split('row');
    const c = worker.controller!;
    const initial = await f.w.current.controller!.planning.inventory();
    for (const name of ['emergence_code_project', 'emergence_code_work', 'emergence_data_analyze'])
      assert.ok(
        initial.capabilities.some((v) => v.id === 'tool:' + name && v.callable),
        name,
      );
    for (const p of f.w.panes.values()) {
      p.controller!.launch.appConfig.toolPolicy.deny = ['emergence_data_*'];
      p.controller!.invalidatePermissions();
    }
    const after = await c.planning.inventory();
    assert.ok(
      after.capabilities.filter((v) => v.id.startsWith('tool:emergence_data_')).every((v) => !v.callable),
    );
    assert.ok(after.capabilities.some((v) => v.id === 'tool:emergence_code_project' && v.callable));
    assert.ok(after.capabilities.some((v) => v.id === 'tool:write' && v.callable));
  } finally {
    await f.close();
  }
});
