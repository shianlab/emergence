import { propose } from './fixtures/plan-proposal.ts';
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { WorkspaceController } from '../src/app/workspace.ts';
import { planSchema } from '../src/core/domain/planning.ts';
import { digest } from '../src/core/storage/execution-journal.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('complete local lifecycle: model plan, execution, user rejection, bounded repair, actual process verification, approved user memory, restart and recall', async () => {
  const f = await executionFixture();
  await f.ctx.plugin(UserApproval);
  let w = f.w,
    planRead = '',
    calls = 0,
    approvals = 0;
  const requests: string[] = [];
  assert.ok(
    !f.ctx.tools.definitions(w.current.controller!.agent).some((t) => t.name === 'skill'),
    'complete core lifecycle must work without a Skill loading tool',
  );
  const dir = resolve('../artifacts/core-phase6');
  await mkdir(dir, { recursive: true });
  await writeFile(join(f.cwd, 'result.txt'), 'seed');
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'read',
        description: 'actual project read',
        parameters: { file_path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args, exec) =>
          readFile(join(f.ctx.workingDirectory.get(exec.agent!.session), args.file_path), 'utf8'),
      }),
    ),
  );
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'bounded real process check',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (_args, exec) => {
          try {
            await promisify(execFile)(
              process.execPath,
              ['-e', "process.exit(require('fs').readFileSync('result.txt','utf8')==='good'?0:7)"],
              { cwd: f.ctx.workingDirectory.get(exec.agent!.session), windowsHide: true },
            );
            return { kind: 'foreground', exitCode: 0 };
          } catch {
            return { kind: 'foreground', exitCode: 7 };
          }
        },
      }),
    ),
  );
  const root = w.current.id,
    rootSession = w.current.controller!.id!;
  const plan = () =>
    planSchema.parse({
      objective: '完成项目并验证',
      constraints: ['仅当前项目'],
      acceptance: ['result.txt 为 good'],
      nonGoals: ['不发布'],
      unknowns: [],
      assumptions: [],
      options: [],
      conflicts: [],
      reason: '小范围实现',
      evidence: [planRead],
      steps: [
        {
          id: 'implement',
          objective: '修改 result.txt 并报告实际结果',
          window: root,
          session: rootSession,
          project: f.cwd,
          model: 'deepseek',
          role: 'developer',
          capabilities: ['tool:write', 'tool:pwsh'],
          dependsOn: [],
          scope: ['result.txt'],
          acceptance: ['result.txt 为 good'],
        },
      ],
    });
  f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    requests.push(JSON.stringify(options));
    calls++;
    const messages = options.messages.map((m) => ({
      role: m.role,
      text: m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
    }));
    const i = messages.findLastIndex(
      (m) =>
        m.role === 'user' && /^(规划 CORE6_PLAN|CORE6_MEMORY|CORE6_RECALL|\[Emergence task )/.test(m.text),
    );
    const input = messages[i]?.text ?? '',
      n = messages.slice(i + 1).filter((m) => m.role === 'tool').length;
    let name = '',
      args: object = {};
    const call = `acceptance-${calls}`;
    if (input.startsWith('规划 CORE6_PLAN') && n < 4) {
      name = ['emergence_analyze', 'read', 'emergence_plan', 'emergence_execute_plan'][n];
      if (n === 0) {
        const p = plan();
        args = {
          objective: p.objective,
          constraints: p.constraints,
          acceptance: p.acceptance,
          nonGoals: p.nonGoals,
          reason: p.reason,
          intent: 'execute',
          route: 'planned',
        };
      } else if (n === 1) {
        planRead = call;
        args = { file_path: 'result.txt' };
      } else
        args =
          n === 2
            ? { plan: propose(plan(), w.current.controller!.planning.intake()!.requirements!) }
            : {
                plan_id: digest(w.current.controller!.planning.snapshot(w.current.controller!.agent)!.plan!),
              };
    } else if (input.startsWith('[Emergence task ')) {
      const id = input.match(/\[Emergence task ([^\]]+)\]/)![1],
        task = w.taskEngine.task(id);
      if (n < 3) {
        name = ['write', 'pwsh', 'emergence_report'][n];
        args =
          n === 0
            ? { file_path: 'result.txt', content: task.repairOf ? 'good' : 'bad' }
            : n === 1
              ? { command: 'bounded node file check' }
              : { outcome: 'success', summary: '写入与检查回执已记录', artifacts: ['result.txt'] };
      }
    }
    if (!name) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const raw = JSON.stringify(args),
      id = ToolCallId(call);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
  const answer = () => {
    for (const p of w.panes.values())
      if (p.controller?.pending) {
        approvals++;
        p.controller.pending.respond('y');
      }
  };
  const settled = async (id: string) => {
    await until(() => {
      answer();
      return ['needs_review', 'succeeded', 'failed'].includes(w.taskEngine.task(id).status);
    });
  };
  const started = performance.now();
  try {
    await w.send(root, '规划 CORE6_PLAN 实现并验证项目');
    await until(() => !!w.taskEngine.state.tasks[0]);
    const task = w.taskEngine.state.tasks[0];
    await settled(task.id);
    assert.equal(task.status, 'needs_review');
    assert.equal(task.artifactVersions.length, 1);
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'bad');
    await assert.rejects(w.taskEngine.review(task.id, true, '不得忽略真实失败'), /真实失败/);
    await w.taskEngine.review(task.id, false, '独立读取发现实际内容错误，需要一次修复');
    const repair = await w.taskEngine.repair(task.id, '将 result.txt 修正为 good，保留原范围');
    await settled(repair.id);
    assert.equal(repair.repairCount, 1);
    assert.deepEqual(repair.permission, task.permission);
    assert.deepEqual(repair.rolePermission, task.rolePermission);
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'good');
    assert.ok(repair.receipts.some((r) => r.kind === 'command' && r.ok && r.exitCode === 0));
    await w.taskEngine.review(repair.id, true, '用户已核对当前文件与实际进程检查');
    await w.panes.get(root)!.controller!.agent.whenIdle();
    await w.panes
      .get(root)!
      .controller!.memory.propose('project', 'fact', 'CORE6_EXPERIENCE：修复后重新核对文件与进程结果');
    const memory = w.panes.get(root)!.controller!.memory,
      entry = (await memory.store.list(await memory.identity(), true))[0];
    assert.ok(entry);
    assert.equal(entry.state, 'candidate');
    assert.equal((await memory.search()).length, 0);
    const decision = w.send(root, `/memory approve ${entry.id}`);
    await until(() => !!w.panes.get(root)!.controller!.pending);
    answer();
    await decision;
    await w.close();
    w = new WorkspaceController(f.ctx, f.launch);
    await w.initialize();
    const before = calls;
    await w.send(root, 'CORE6_RECALL 使用当前有效经验');
    await w.panes.get(root)!.controller!.agent.whenIdle();
    assert.equal(calls, before + 1);
    assert.ok(requests.at(-1)!.includes('CORE6_EXPERIENCE'));
    assert.equal(w.taskEngine.task(repair.id).status, 'succeeded');
    const report = {
      passed: true,
      provider: 'local deterministic fixture with real Harness/files/processes',
      durationMs: Math.round(performance.now() - started),
      modelRequests: calls,
      repairAttempts: 1,
      approvals,
      tasks: w.taskEngine.state.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        repairOf: t.repairOf,
        assessment: t.assessment?.kind,
      })),
      checks: {
        modelPlan: true,
        actualWrite: true,
        userRejection: true,
        boundedRepair: true,
        actualVerification: true,
        candidateNeedsHuman: true,
        persistedMemory: true,
        restartWithoutTaskReplay: true,
        nextRequestRecall: true,
      },
    };
    await writeFile(join(dir, 'lifecycle.json'), JSON.stringify(report, null, 2));
  } finally {
    await w.close();
    await f.close();
  }
});
