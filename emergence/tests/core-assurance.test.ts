import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileObservation } from '../src/core/application/execution-evidence.ts';
import { HistoricalOrchestrationWorkspace as WorkspaceController } from './fixtures/historical-orchestration.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

async function fixture({
  failedCommand = false,
  forged = false,
  mutateRead = false,
  correctSubmission = false,
  mixedEvidence = false,
  nativeVerification = false,
  failedNativeVerification = false,
  directoryQuery = false,
  prematureReport = false,
  context = '',
  objective = 'fixture:write',
  reviewFile = 'result.txt',
}: {
  reviewFile?: string;
  context?: string;
  objective?: string;
  failedCommand?: boolean;
  forged?: boolean;
  mutateRead?: boolean;
  correctSubmission?: boolean;
  mixedEvidence?: boolean;
  nativeVerification?: boolean;
  failedNativeVerification?: boolean;
  directoryQuery?: boolean;
  prematureReport?: boolean;
} = {}) {
  const f = await executionFixture(),
    original = f.provider.stream.bind(f.provider),
    auditPrompts: string[] = [];
  await f.ctx.plugin(UserApproval);
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'glob',
        description: 'actual directory listing',
        parameters: { path: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: (args) => readdir(args.path),
      }),
    ),
  );
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'read',
        description: 'real read',
        parameters: { file_path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args, exec) => {
          const path = join(f.ctx.workingDirectory.get(exec.agent!.session), args.file_path),
            value = await readFile(path, 'utf8');
          if (mutateRead) await writeFile(path, 'changed');
          return value;
        },
      }),
    ),
  );
  f.ctx.effect(() =>
    f.ctx.tools.register(
      defineTool({
        name: 'pwsh',
        description: 'actual local check process',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async () => {
          try {
            await promisify(execFile)(process.execPath, ['-e', `process.exit(${failedCommand ? 7 : 0})`], {
              windowsHide: true,
            });
            return { kind: 'foreground', exitCode: 0 };
          } catch {
            return { kind: 'foreground', exitCode: 7 };
          }
        },
      }),
    ),
  );
  f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
    const messages = options.messages.map((m) => ({ role: m.role, text: JSON.stringify(m.content) })),
      i = messages.findLastIndex((m) => m.role === 'user' && m.text.includes('[Emergence task '));
    const id = messages[i]?.text.match(/\[Emergence task ([^\]]+)\]/)?.[1],
      task = f.w.collaboration.state.tasks.find((t) => t.id === id);
    if (!task?.assessment) {
      yield* original(options);
      return;
    }
    auditPrompts.push(JSON.stringify(options));
    const n = messages.slice(i + 1).filter((m) => m.role === 'tool').length;
    if (n >= (correctSubmission || mixedEvidence || prematureReport ? 4 : 3)) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prematureReport && n === 1)
      assert.equal(task.report, undefined, 'a rejected report must not mutate the task');
    const name = prematureReport
      ? ['emergence_report', 'read', 'emergence_assess', 'emergence_report'][n]
      : mixedEvidence
        ? ['read', 'pwsh', 'emergence_assess', 'emergence_report'][n]
        : n === 0
          ? directoryQuery
            ? 'glob'
            : task.assessment.kind === 'review'
              ? 'read'
              : nativeVerification
                ? 'emergence_verify_file'
                : 'pwsh'
          : n === 1 || (correctSubmission && n === 2)
            ? 'emergence_assess'
            : 'emergence_report';
    const args =
      name === 'glob'
        ? { path: f.cwd }
        : name === 'read'
          ? { file_path: reviewFile }
          : name === 'emergence_verify_file'
            ? {
                file_path: reviewFile,
                checks: [
                  {
                    property: 'characters',
                    operator: 'at-least',
                    expectedNumber: failedNativeVerification ? 999 : 1,
                  },
                  { property: 'utf8Valid', operator: 'equals', expectedBoolean: true },
                ],
              }
            : name === 'pwsh'
              ? { command: 'node fixture-check' }
              : name === 'emergence_assess'
                ? {
                    checks: mixedEvidence
                      ? [
                          {
                            criterion: 0,
                            passed: true,
                            receipts: [`audit-${id}-0`],
                            note: '实际独立读取验证文件内容',
                          },
                          {
                            criterion: 1,
                            passed: true,
                            receipts: [`audit-${id}-1`],
                            note: '实际独立进程退出码为零',
                          },
                        ]
                      : [
                          {
                            criterion: 0,
                            passed: true,
                            receipts: [
                              forged || (correctSubmission && n === 1)
                                ? 'invented'
                                : `audit-${id}-${prematureReport ? 1 : 0}`,
                            ],
                            note: '逐项核对实际文件或进程退出状态',
                          },
                        ],
                  }
                : { outcome: 'success', summary: '独立检查完成', artifacts: [] };
    const raw = JSON.stringify(args),
      call = ToolCallId(`audit-${id}-${n}`);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: call, name, argumentsDelta: raw };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: call, name, arguments: raw } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
  const master = f.w.current,
    worker = await f.w.split('row');
  f.w.collaboration.configure(master.id, [worker.id]);
  const task = await f.w.collaboration.enqueue(master.id, worker.id, 'subject', objective, [], {
    context,
    role: 'developer',
    scope: ['result.txt'],
    acceptance: mixedEvidence
      ? ['实际文件内容正确', '实际运行验证通过']
      : directoryQuery
        ? ['目录中存在 result.txt']
        : ['实际文件及检查成功'],
  });
  await until(() => task.status === 'needs_review');
  const settle = async (id: string) => {
    await until(() => {
      for (const p of f.w.panes.values()) if (p.controller?.pending) p.controller.pending.respond('y');
      return ['succeeded', 'failed', 'needs_review'].includes(f.w.collaboration.task(id).status);
    });
  };
  return { ...f, master, worker, task, settle, auditPrompts };
}

test('independent real reads and actual process exits produce separate evidence; model approval and memory depend on current artifacts', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration;
    await assert.rejects(c.review(f.task.id, true, '模型自称完成', 'model'), /独立审查/);
    await assert.rejects(c.assurance.request(f.task.id, 'review', f.master.id, f.worker.id), /独立/);
    const review = await c.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(review.id);
    assert.equal(review.status, 'succeeded', JSON.stringify(review.result));
    await assert.rejects(c.assurance.request(f.task.id, 'verify', f.master.id, review.target), /不同会话/);
    const verify = await c.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(verify.id);
    assert.equal(verify.status, 'succeeded', JSON.stringify(verify.result));
    const status = await c.assurance.status(f.task.id);
    assert.equal(status.review, true);
    assert.equal(status.verification, true);
    assert.equal(status.userAcceptance, null);
    assert.ok(verify.receipts.some((r) => r.kind === 'command' && r.exitCode === 0));
    await c.review(f.task.id, true, '实际独立回执均通过', 'model');
    assert.equal(f.task.review?.actor, 'model');
    const memory = f.master.controller!.memory,
      e = await memory.propose('project', 'fact', '此项目有独立审查和验证入口', f.task.id);
    const pending = memory.change(e.id, 'approve');
    await until(() => !!f.master.controller!.pending);
    await writeFile(join(f.cwd, 'result.txt'), 'external change');
    f.master.controller!.pending!.respond('y');
    await assert.rejects(pending, /改变|失效|缺少当前版本/);
    assert.equal((await memory.search()).length, 0);
    assert.equal((await c.assurance.status(f.task.id)).verification, false);
    const other = join(f.home, 'other-project');
    await mkdir(other);
    await f.ctx.workingDirectory.set(f.master.controller!.agent, other);
    await assert.rejects(
      memory.propose('project', 'fact', '不能把旧项目经验写到新项目', f.task.id),
      /不属于当前项目/,
    );
  } finally {
    await f.close();
  }
});

test('read-only review hides mutation and command tools only for its own task lifetime', async () => {
  const f = await fixture();
  try {
    const review = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(review.id);
    assert.equal(review.status, 'succeeded', JSON.stringify(review.result));
    const requests = f.auditPrompts.map((s) => JSON.parse(s));
    for (const request of requests) {
      const names = request.tools.map((t: { name: string }) => t.name);
      assert.ok(names.includes('read') && names.includes('emergence_assess'));
      assert.ok(!names.includes('pwsh') && !names.includes('write'));
    }
    const agent = f.w.panes.get(review.target)!.controller!.agent;
    await until(() => !!f.ctx.tools.get('pwsh', agent));
    f.auditPrompts.length = 0;
    const verify = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(verify.id);
    assert.equal(verify.status, 'succeeded', JSON.stringify(verify.result));
    assert.ok(
      f.auditPrompts.every((s) => JSON.parse(s).tools.some((t: { name: string }) => t.name === 'pwsh')),
    );
    assert.ok(verify.receipts.some((r) => r.kind === 'command' && r.exitCode === 0));
  } finally {
    await f.close();
  }
});

test('a failed actual verification process cannot be hidden by success claims or repeated review loops', async () => {
  const f = await fixture({ failedCommand: true });
  try {
    const c = f.w.collaboration,
      audit = await c.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(audit.id);
    assert.notEqual(audit.status, 'succeeded');
    assert.equal((await c.assurance.status(f.task.id)).verification, false);
    assert.ok(audit.receipts.some((r) => r.exitCode === 7 && !r.ok));
    await assert.rejects(c.assurance.request(audit.id, 'review', f.master.id), /递归/);
    await assert.rejects(c.repair(audit.id, '再试一次'), /循环/);
    const second = await c.assurance.request(f.task.id, 'verify', f.master.id);
    assert.equal(second.id, audit.id, 'failed evidence is retained, not retried by polling');
    assert.equal(c.state.tasks.filter((task) => task.assessment?.subject === f.task.id).length, 1);
  } finally {
    await f.close();
  }
});

test('fabricated receipt IDs never become review evidence', async () => {
  const f = await fixture({ forged: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    assert.notEqual(audit.status, 'succeeded');
    assert.equal(audit.assessment!.checks, undefined);
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).review, false);
  } finally {
    await f.close();
  }
});

test('rejected metadata can be corrected using actual own receipts; the rejection remains in the session log', async () => {
  const f = await fixture({ correctSubmission: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal(audit.result?.errors.length, 0);
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).review, true);
    assert.ok(
      f.w.panes
        .get(audit.target)!
        .controller!.agent.session.snapshotEvents()
        .some((e) => e.type === 'tool/result' && e.data.message.isError),
    );
    assert.notEqual(audit.assessment?.checks?.[0].receipts[0], 'invented');
    assert.equal(audit.result!.failures!.length, 1);
    assert.equal(audit.result!.failures![0].resolution?.kind, 'submission');
  } finally {
    await f.close();
  }
});

test('implementation verification accepts file-reading criteria plus an actual successful process criterion', async () => {
  const f = await fixture({ mixedEvidence: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).verification, true);
    const checks = audit.assessment!.checks!;
    assert.equal(checks.length, 2);
    assert.equal(audit.receipts.find((r) => r.id === checks[0].receipts[0])!.kind, 'read');
    assert.equal(audit.receipts.find((r) => r.id === checks[1].receipts[0])!.exitCode, 0);
  } finally {
    await f.close();
  }
});

test('native file predicates provide real verification without a shell and expire when the file changes', async () => {
  const f = await fixture({ nativeVerification: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).verification, true);
    const receipt = audit.receipts.find((r) => r.tool === 'emergence_verify_file')!;
    assert.equal(receipt.kind, 'read');
    assert.equal(receipt.exitCode, undefined, 'A native predicate must not fabricate a process exit');
    assert.equal(receipt.manifest?.contract.output, 'file-check');
    assert.equal(
      audit.receipts.some((r) => r.kind === 'command'),
      false,
    );
    await writeFile(join(f.cwd, 'result.txt'), 'different');
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).verification, false);
  } finally {
    await f.close();
  }
});

test('failed native predicates cannot be covered by a model success claim', async () => {
  const f = await fixture({ nativeVerification: true, failedNativeVerification: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(audit.id);
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).verification, false);
    assert.equal(audit.receipts.find((r) => r.tool === 'emergence_verify_file')!.ok, false);
    assert.equal(audit.assessment?.checks, undefined);
  } finally {
    await f.close();
  }
});

test('native text counts distinguish bytes, Unicode code points and Han characters without treating invalid UTF8 as empty', async () => {
  const f = await executionFixture();
  try {
    const file = join(f.cwd, 'counts.txt');
    await writeFile(file, '涌现A😀\n');
    const value = await fileObservation(file, true);
    assert.equal(value.characters, 5);
    assert.equal(value.hanCharacters, 2);
    assert.equal(value.fileSize, 12);
    await writeFile(file, Buffer.from([0xff]));
    const invalid = await fileObservation(file, true);
    assert.equal(invalid.utf8Valid, false);
    assert.equal(invalid.characters, undefined);
  } finally {
    await f.close();
  }
});

test('directory query evidence is a result snapshot, not an unreadable regular file', async () => {
  const f = await fixture({ directoryQuery: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal(audit.receipts[0].queryRoot, f.cwd);
    assert.equal(audit.receipts[0].fileHash, undefined);
    assert.equal(audit.receipts[0].path, undefined);
  } finally {
    await f.close();
  }
});

test('a premature report stays uncommitted and can be corrected after actual assessment', async () => {
  const f = await fixture({ prematureReport: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal(audit.report?.outcome, 'success');
    assert.ok(audit.assessment?.checks?.length);
  } finally {
    await f.close();
  }
});

test('a graph waiting for acceptance can add independent audit workers without replacing existing task owners', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration,
      downstream = await c.enqueue(f.master.id, f.worker.id, 'after-review', 'fixture:write', [f.task.id], {
        role: 'developer',
        scope: ['result.txt'],
        acceptance: ['检查文件'],
      });
    const review = await c.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(review.id);
    assert.equal(review.status, 'succeeded');
    assert.equal(downstream.status, 'queued');
    await assert.rejects(
      Promise.resolve().then(() => c.configure(review.target, [f.worker.id])),
      /更换协作角色/,
    );
    assert.equal(c.state.master, f.master.id);
    assert.equal(downstream.target, f.worker.id);
  } finally {
    await f.close();
  }
});

test('a file changed during the actual read cannot certify evidence for the new bytes', async () => {
  const f = await fixture({ mutateRead: true });
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.receipts[0].ok, false);
    assert.equal(audit.receipts[0].fileSize, 7);
    assert.equal((await f.w.collaboration.assurance.status(f.task.id)).review, false);
  } finally {
    await f.close();
  }
});

test('native file observations distinguish final LF, CRLF, BOM and no newline without shell execution', async () => {
  const f = await executionFixture();
  try {
    const path = join(f.cwd, 'bytes.txt');
    await writeFile(path, '\uFEFF中\r\n');
    const crlf = await fileObservation(path);
    assert.equal(crlf.fileSize, 8);
    assert.equal(crlf.utf8Bom, true);
    assert.equal(crlf.trailingNewline, 'CRLF');
    await writeFile(path, '中\n');
    const lf = await fileObservation(path);
    assert.equal(lf.fileSize, 4);
    assert.equal(lf.trailingNewline, 'LF');
    assert.equal(lf.utf8Bom, false);
    assert.notEqual(lf.hash, crlf.hash);
    await writeFile(path, '中');
    assert.equal((await fileObservation(path)).trailingNewline, 'none');
  } finally {
    await f.close();
  }
});

test('long original context and goal survive real independent verification without recursive expansion', async () => {
  const context = 'x'.repeat(7890) + '约束尾部必须保留';
  const objective = 'y'.repeat(11900) + '原任务目标尾部';
  const f = await fixture({ context, objective, mixedEvidence: true });
  try {
    const before = f.w.panes.size;
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
    assert.equal(audit.contract!.context, context);
    assert.deepEqual(audit.contract!.acceptance, f.task.contract!.acceptance);
    assert.equal(audit.assessment!.subject, f.task.id);
    assert.equal(f.w.panes.size, before + 1);
    assert.ok(
      f.auditPrompts.some(
        (prompt) =>
          prompt.includes(context) &&
          prompt.includes(objective) &&
          prompt.includes('独立审查规则') &&
          prompt.includes('原生数据交付索引'),
      ),
    );
  } finally {
    await f.close();
  }
});

test('cancelled audit allocation removes only its unused new pane', async () => {
  const f = await fixture();
  try {
    const before = [...f.w.panes.keys()],
      split = f.w.split.bind(f.w);
    let valid = true;
    f.w.split = async (...args) => {
      const pane = await split(...args);
      valid = false;
      return pane;
    };
    await assert.rejects(
      f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id, undefined, () => valid),
      /暂停或取消/,
    );
    assert.deepEqual([...f.w.panes.keys()], before);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
  } finally {
    await f.close();
  }
});

test('failed audit persistence rolls back the unstarted task and newly allocated pane', async () => {
  const f = await fixture();
  const save = f.w.save.bind(f.w);
  try {
    const before = [...f.w.panes.keys()];
    let injected = false;
    f.w.save = async () => {
      if (!injected && f.w.collaboration.state.tasks.some((t) => t.assessment)) {
        injected = true;
        throw new Error('fixture admission storage failure');
      }
      return save();
    };
    await assert.rejects(
      f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id),
      /storage failure/,
    );
    assert.equal(injected, true);
    assert.deepEqual([...f.w.panes.keys()], before);
    assert.equal(f.w.collaboration.state.tasks.length, 1);
    assert.equal(f.w.collaboration.state.paused, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.w.save = save;
    await f.close();
  }
});

test('audit rollback never closes an explicit user window or a new pane with a user draft', async () => {
  const f = await fixture();
  try {
    const spare = await f.w.split('row'),
      before = f.w.panes.size;
    const enqueue = f.w.collaboration.enqueue.bind(f.w.collaboration);
    f.w.collaboration.enqueue = async () => {
      throw new Error('fixture enqueue failure');
    };
    await assert.rejects(
      f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id, spare.id),
      /enqueue failure/,
    );
    assert.equal(f.w.panes.size, before);
    f.w.collaboration.enqueue = enqueue;
    spare.draft = '保留已有窗口草稿';
    const split = f.w.split.bind(f.w);
    let valid = true;
    f.w.split = async (...args) => {
      const pane = await split(...args);
      pane.draft = '用户刚输入的内容';
      valid = false;
      return pane;
    };
    await assert.rejects(
      f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id, undefined, () => valid),
      /暂停或取消/,
    );
    assert.equal(f.w.panes.size, before + 1);
    assert.ok([...f.w.panes.values()].some((p) => p.draft === '用户刚输入的内容'));
  } finally {
    await f.close();
  }
});

test('automatic audits reuse independent empty windows at 4, 8 and 16 panes and complete real checks', async () => {
  for (const count of [4, 8, 16]) {
    const f = await fixture({ mixedEvidence: true });
    try {
      while (f.w.panes.size < count) await f.w.split('row');
      const audit = await f.w.collaboration.assurance.request(f.task.id, 'verify', f.master.id);
      await f.settle(audit.id);
      assert.equal(audit.status, 'succeeded', JSON.stringify(audit.result));
      assert.equal(f.w.panes.size, count);
      assert.notEqual(audit.targetSession, f.task.targetSession);
      await assert.rejects(
        f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id, audit.target),
        /不同会话/,
      );
    } finally {
      await f.close();
    }
  }
});

test('idle personal conversations and draft windows are not silently reused for independent audits', async () => {
  const f = await fixture();
  try {
    const personal = await f.w.split('row');
    await personal.controller!.send('已有个人对话');
    await personal.controller!.agent.whenIdle();
    await assert.rejects(
      f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id, personal.id),
      /个人对话/,
    );
    const draft = await f.w.split('row');
    draft.draft = '尚未发送的工作';
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    assert.notEqual(audit.target, personal.id);
    assert.notEqual(audit.target, draft.id);
    await f.settle(audit.id);
    assert.equal(audit.status, 'succeeded');
  } finally {
    await f.close();
  }
});

test('concurrent and late audit requests reuse one versioned record and recheck each caller', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration;
    const requests = await Promise.all(
      Array.from({ length: 12 }, () => c.assurance.request(f.task.id, 'review', f.master.id)),
    );
    assert.equal(new Set(requests.map((task) => task.id)).size, 1);
    assert.match(requests[0].requestKey, /^audit-v2-[a-f0-9]{64}$/);
    await f.settle(requests[0].id);
    assert.equal((await c.assurance.request(f.task.id, 'review', f.master.id)).id, requests[0].id);
    await assert.rejects(c.assurance.request(f.task.id, 'review', f.worker.id), /原派发|主控/);
    await assert.rejects(
      c.assurance.request(f.task.id, 'review', f.master.id, undefined, () => false),
      /暂停或取消/,
    );
    assert.equal(c.state.tasks.filter((task) => task.assessment).length, 1);
  } finally {
    await f.close();
  }
});

test('objective closure revalidates referenced inputs even when delivered files are unchanged', async () => {
  const f = await fixture({ reviewFile: 'source.txt' });
  try {
    const c = f.w.collaboration;
    await writeFile(join(f.cwd, 'source.txt'), 'independent acceptance source');
    const review = await c.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(review.id);
    const verify = await c.assurance.request(f.task.id, 'verify', f.master.id);
    await f.settle(verify.id);
    await c.review(f.task.id, true, '独立核验全部通过', 'model');
    await c.assurance.completion([f.task]);
    await writeFile(join(f.cwd, 'source.txt'), 'changed after acceptance');
    await assert.rejects(c.assurance.completion([f.task]), /缺少最终版本/);
    await assert.rejects(c.assurance.request(f.task.id, 'review', f.master.id), /回执已失效/);
    assert.equal(c.state.tasks.length, 3, 'stale evidence cannot generate recursive verification');
  } finally {
    await f.close();
  }
});

test('missing receipts and mismatched provenance cannot certify persisted successful checks', async () => {
  const f = await fixture();
  try {
    const c = f.w.collaboration;
    const audit = await c.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    const original = structuredClone(audit.receipts);
    c.lifecycle.amend(audit, { receipts: [] });
    assert.equal((await c.assurance.status(f.task.id)).review, false);
    const wrong = structuredClone(original);
    wrong[0].manifest!.taskId = f.task.id;
    c.lifecycle.amend(audit, { receipts: wrong });
    assert.equal((await c.assurance.status(f.task.id)).review, false);
    c.lifecycle.amend(audit, { receipts: original });
    assert.equal((await c.assurance.status(f.task.id)).review, true);
    // Old rule-version evidence remains readable but cannot silently satisfy the new gate.
    c.lifecycle.amend(audit, {
      requestKey: `audit-${f.task.id}-review-0`,
      assessment: { ...audit.assessment!, version: 'legacy-rule-digest' },
    });
    assert.equal((await c.assurance.status(f.task.id)).review, false);
    const fresh = await c.assurance.request(f.task.id, 'review', f.master.id);
    assert.notEqual(fresh.id, audit.id);
    await f.settle(fresh.id);
    assert.equal((await c.assurance.status(f.task.id)).review, true);
    assert.equal(audit.assessment!.version, 'legacy-rule-digest', 'legacy evidence is never rewritten');
  } finally {
    await f.close();
  }
});

test('audit identity survives workspace restart without creating another check', async () => {
  const f = await fixture();
  let restored: WorkspaceController | undefined;
  try {
    const audit = await f.w.collaboration.assurance.request(f.task.id, 'review', f.master.id);
    await f.settle(audit.id);
    const expected = structuredClone(audit);
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    const c = restored.collaboration;
    assert.equal(c.state.paused, true);
    c.configure(
      f.master.id,
      [...restored.panes.keys()].filter((id) => id !== f.master.id),
    );
    const reused = await c.assurance.request(f.task.id, 'review', f.master.id);
    assert.equal(reused.id, expected.id);
    assert.equal(reused.requestKey, expected.requestKey);
    assert.deepEqual(reused.assessment, expected.assessment);
    assert.equal(c.state.tasks.length, 2);
  } finally {
    await restored?.close();
    await f.close();
  }
});
