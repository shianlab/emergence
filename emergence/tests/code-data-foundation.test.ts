import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import UserApproval from '@deepseek-ai/dsh-user-approval';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceController } from '../src/app/workspace.ts';
import { evaluatePermission } from '../src/core/adapters/permissions.ts';
import { CoreAssurance } from '../src/core/application/assurance.ts';
import { allocationViolation } from '../src/core/application/task-allocation.ts';
import type { TaskEngine } from '../src/core/application/task-engine.ts';
import { TaskLifecycle } from '../src/core/application/task-lifecycle.ts';
import { captureToolEvidence, evidenceIsCurrent } from '../src/core/application/tool-evidence.ts';
import { receiptSchema, type EvidenceReceipt } from '../src/core/domain/assurance.ts';
import { type PermissionSnapshot } from '../src/core/domain/permissions.ts';
import { isFileCapability, toolContract, toolOutcome } from '../src/core/domain/tool-contract.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

test('host contracts preserve mode boundaries and ignore remote read-only claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emergence-contract-'));
  try {
    for (const mode of ['plan', 'ask', 'edit', 'auto'] as const) {
      const p: PermissionSnapshot = { mode, root, rules: [], deny: [], confirm: [] };
      for (const name of ['emergence_untrusted', 'mcp__sql__query']) {
        const arguments_ = {
          file_path: 'result.txt',
          readOnlyHint: true,
          contract: { authority: 'host', permission: 'read' },
        };
        assert.equal(
          evaluatePermission(p, { name, arguments: arguments_, cwd: root, actor: 'test' }).effect,
          mode === 'plan' ? 'deny' : 'ask',
        );
        assert.equal(toolContract(name, arguments_).authority, 'unknown');
        assert.equal(isFileCapability('tool:' + name), false);
      }
      assert.equal(
        evaluatePermission(p, { name: 'read', arguments: { file_path: 'x' }, cwd: root, actor: 'test' })
          .effect,
        'allow',
      );
      assert.equal(
        evaluatePermission(p, { name: 'write', arguments: { file_path: 'x' }, cwd: root, actor: 'test' })
          .effect,
        mode === 'plan' ? 'deny' : mode === 'ask' ? 'ask' : 'allow',
      );
    }
    assert.equal(toolContract('working_directory').sideEffect, false);
    assert.equal(toolContract('working_directory', { cd: '..' }).sideEffect, true);
    assert.equal(toolContract('pwsh').externalEffects.database, 'unknown');
    assert.ok(Object.isFrozen(toolContract('read')));
    assert.ok(Object.isFrozen(toolContract('read').budget));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host capture records real file versions and invalidates stale inputs and outputs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'emergence-evidence-')),
    receipts: EvidenceReceipt[] = [];
  const file = join(cwd, 'sample.csv');
  const call = {
    callId: 'read-1',
    name: 'read',
    arguments: { file_path: 'sample.csv' },
    cwd,
    taskId: 'task',
    runId: 'run',
    sessionId: 'session',
    signal: new AbortController().signal,
  };
  try {
    await writeFile(file, 'value\n10\n20\n');
    await captureToolEvidence(
      call,
      async () => ({ value: await readFile(file, 'utf8') }),
      async (r) => {
        receipts.push(r);
      },
    );
    assert.equal(receipts[0].ok, true);
    assert.equal(receipts[0].manifest?.inputs[0].state, 'present');
    assert.equal(await evidenceIsCurrent(receipts[0]), true);
    await writeFile(file, 'value\n30\n');
    assert.equal(await evidenceIsCurrent(receipts[0]), false);
    await captureToolEvidence(
      { ...call, callId: 'write-1', name: 'write' },
      async () => {
        await writeFile(file, 'value\n40\n');
        return { value: 'written' };
      },
      async (r) => {
        receipts.push(r);
      },
    );
    assert.equal(receipts[1].manifest?.outputs[0].state, 'present');
    assert.equal(await evidenceIsCurrent(receipts[1]), true);
    await rm(file);
    assert.equal(await evidenceIsCurrent(receipts[1]), false);
    await captureToolEvidence(
      call,
      async () => ({ value: 'claimed read success' }),
      async (r) => {
        receipts.push(r);
      },
    );
    assert.equal(receipts[2].ok, false);
    assert.equal(receipts[2].manifest?.inputs[0].state, 'missing');
    await captureToolEvidence(
      { ...call, name: 'write' },
      async () => ({ value: 'claimed write success without a file' }),
      async (r) => {
        receipts.push(r);
      },
    );
    assert.equal(receipts[3].ok, false);
    assert.equal(receipts[3].manifest?.checks.find((c) => c.kind === 'output-version')?.passed, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('changing a file during a read cannot certify the returned content', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'emergence-version-'));
  let receipt: EvidenceReceipt | undefined;
  try {
    await writeFile(join(cwd, 'x'), 'old');
    await captureToolEvidence(
      {
        callId: 'race',
        name: 'read',
        arguments: { path: 'x' },
        cwd,
        taskId: 't',
        sessionId: 's',
        signal: new AbortController().signal,
      },
      async () => {
        const value = await readFile(join(cwd, 'x'), 'utf8');
        await writeFile(join(cwd, 'x'), 'new');
        return { value };
      },
      async (r) => {
        receipt = r;
      },
    );
    assert.equal(receipt?.manifest?.status, 'failed');
    assert.equal(receipt?.manifest?.checks.find((c) => c.kind === 'input-version')?.passed, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('failed, cancelled and unfinished execution never produces successful evidence; raw payloads stay out of manifests', async () => {
  const receipts: EvidenceReceipt[] = [],
    abort = new AbortController();
  const call = {
    callId: 'cmd',
    name: 'pwsh',
    arguments: { command: 'secret-command-content' },
    cwd: tmpdir(),
    taskId: 't',
    sessionId: 's',
    signal: abort.signal,
  };
  const record = async (r: EvidenceReceipt) => {
    receipts.push(r);
  };
  for (const [value, status] of [
    [{ exitCode: 0 }, 'succeeded'],
    [{ exitCode: 1 }, 'failed'],
    [{ timedOut: true }, 'failed'],
    [{ kind: 'background' }, 'pending'],
    [{}, 'pending'],
    [{ stopped: true }, 'cancelled'],
  ] as const) {
    await captureToolEvidence(call, async () => ({ value }), record);
    assert.equal(receipts.at(-1)?.manifest?.status, status);
    assert.equal(receipts.at(-1)?.ok, status === 'succeeded');
  }
  await assert.rejects(
    captureToolEvidence(
      call,
      async () => {
        throw new Error('secret-error-content');
      },
      record,
    ),
    /secret-error/,
  );
  assert.equal(receipts.at(-1)?.manifest?.status, 'failed');
  abort.abort();
  await captureToolEvidence(call, async () => ({ value: { exitCode: 0 } }), record);
  assert.equal(receipts.at(-1)?.manifest?.status, 'cancelled');
  const json = JSON.stringify(receipts);
  assert.equal(json.includes('secret-command-content'), false);
  assert.equal(json.includes('secret-error-content'), false);
  assert.ok(receipts[0].manifest?.codeHash);
  assert.equal(toolOutcome('pwsh', { exitCode: 1 }, false, false), 'failed');
});

test('unknown prefixes get untrusted receipts, while controls cannot certify themselves; legacy receipt shape remains valid', async () => {
  const receipts: EvidenceReceipt[] = [],
    call = {
      callId: 'unknown',
      name: 'emergence_external',
      arguments: {},
      cwd: tmpdir(),
      taskId: 't',
      sessionId: 's',
      signal: new AbortController().signal,
    };
  await captureToolEvidence(
    call,
    async () => ({ value: { manifest: { status: 'succeeded', inputs: ['forged'] }, secret: 'private-row' } }),
    async (r) => {
      receipts.push(r);
    },
  );
  assert.equal(receipts[0].kind, 'other');
  assert.equal(receipts[0].manifest?.contract.authority, 'unknown');
  assert.equal(receipts[0].manifest?.resourceCoverage, 'untracked');
  assert.deepEqual(receipts[0].manifest?.inputs, []);
  assert.equal(JSON.stringify(receipts).includes('private-row'), false);
  await captureToolEvidence(
    { ...call, name: 'emergence_report' },
    async () => ({ value: 'success' }),
    async (r) => {
      receipts.push(r);
    },
  );
  assert.equal(receipts.length, 1);
  const { manifest, ...legacy } = receipts[0];
  assert.deepEqual(receiptSchema.parse(legacy), legacy);
  assert.equal(receiptSchema.parse(legacy).manifest, undefined);
  assert.equal(
    receiptSchema.safeParse({ ...receipts[0], manifest: { ...manifest, schemaVersion: 2 } }).success,
    false,
  );
});

test('real Harness persists manifests in existing journal and enforces allocated paths', async () => {
  const f = await executionFixture();
  let restored: WorkspaceController | undefined;
  try {
    const worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'manifest', 'fixture:write', [], {
      role: 'developer',
      scope: ['result.txt'],
      acceptance: ['actual file'],
    });
    await until(() => task.status === 'needs_review');
    const receipt = task.receipts.find((r) => r.tool === 'write')!;
    assert.equal(receipt.manifest?.status, 'succeeded');
    assert.equal(receipt.manifest?.taskId, task.id);
    assert.equal(receipt.manifest?.runId, task.runId);
    assert.equal(receipt.manifest?.outputs[0].path, join(f.cwd, 'result.txt'));
    const bounded = { ...task, allocation: { ...task.allocation!, paths: [join(f.cwd, 'result.txt')] } };
    assert.equal(allocationViolation(bounded, 'write', { path: 'result.txt' }), undefined);
    assert.match(allocationViolation(bounded, 'write', { path: 'outside.txt' })!, /超出/);
    assert.ok(allocationViolation(bounded, 'emergence_custom', { path: 'result.txt', readOnlyHint: true }));
    await f.w.close();
    restored = new WorkspaceController(f.ctx, f.launch);
    await restored.initialize();
    assert.deepEqual(restored.taskEngine.task(task.id).receipts, task.receipts);
    assert.equal(await evidenceIsCurrent(restored.taskEngine.task(task.id).receipts[0]), true);
  } finally {
    await restored?.close();
    await f.close();
  }
});

test('real Harness no longer exempts arbitrary emergence-prefixed execution from receipts', async () => {
  const f = await executionFixture();
  try {
    const name = 'emergence_fixture_effect';
    await f.ctx.plugin(UserApproval);
    f.config.permissions.rules.push({ tool: name, effect: 'allow' });
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name,
          description: 'untrusted extension fixture',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          execute: async () => 'actual external result',
        }),
      ),
    );
    let step = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (step >= 2) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const n = step++,
        tool = n ? 'emergence_report' : name,
        id = ToolCallId('contract-' + n);
      const raw = JSON.stringify(n ? { outcome: 'success', summary: 'fixture done' } : {});
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const worker = await f.w.split('row');
    const task = await f.w.taskEngine.enqueue(worker.id, worker.id, 'external', 'fixture:extension', [], {
      role: 'developer',
      scope: ['.'],
      acceptance: ['external result observed'],
    });
    await until(() => {
      if (worker.controller?.pending) worker.controller.pending.respond('y');
      return task.status === 'needs_review';
    });
    assert.equal(task.receipts.length, 1);
    assert.equal(task.receipts[0].manifest?.contract.authority, 'unknown');
    assert.equal(task.receipts[0].kind, 'other');
  } finally {
    await f.close();
  }
});

test('evidence budget reserves in-flight slots before concurrent effects start', async () => {
  const legacy = {
    id: 'prior',
    tool: 'external',
    kind: 'other' as const,
    ok: true,
    hash: 'legacy',
    argumentsHash: 'legacy',
  };
  const task = {
    id: 't',
    target: 'pane',
    targetSession: 's',
    runId: 'run',
    modelId: 'fixture',
    receipts: Array.from({ length: 127 }, () => ({ ...legacy })),
  };
  let handler: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  let release!: () => void,
    calls = 0,
    saves = 0;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const context = {
    on: (_name: string, callback: typeof handler) => {
      handler = callback;
      return () => {};
    },
    tools: { register: () => () => {} },
    workingDirectory: { get: () => tmpdir() },
  };
  const collaboration = {
    state: { tasks: [task] },
    current: () => task,
    lifecycle: new TaskLifecycle({ journal: {} } as ConstructorParameters<typeof TaskLifecycle>[0]),
    workspace: {
      ctx: context,
      panes: new Map([
        [
          'pane',
          {
            controller: {
              permissionSnapshot: () => ({ mode: 'ask', root: tmpdir(), rules: [], deny: [], confirm: [] }),
              permissionConstraints: () => [],
            },
          },
        ],
      ]),
      save: async () => {
        saves++;
      },
    },
  } as unknown as TaskEngine;
  new CoreAssurance(collaboration).mount();
  const exec = {
    name: 'emergence_external',
    callId: 'new',
    arguments: {},
    agent: { session: { id: 's' } },
    signal: new AbortController().signal,
  };
  const next = async () => {
    calls++;
    await held;
    return { value: 'actual', content: [] };
  };
  const first = handler!(exec, next);
  try {
    await assert.rejects(handler!(exec, next), /证据预算/);
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
  assert.equal(task.receipts.length, 128);
  assert.equal(saves, 1);
  await assert.rejects(handler!(exec, next), /证据预算/);
});
