import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { executionFixture, until } from './fixtures/core-execution.ts';

async function* call(name: string, args: object): AsyncIterable<StreamChunk> {
  const id = ToolCallId(name + '-clarification');
  const raw = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

test('a real question answer reopens analysis, preserves constraints and dispatches to the worker once', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserQuestions);
    await f.ctx.plugin(AskUser);
    const main = f.w.current;
    const c = main.controller!;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    // This regression owns admission and execution; existing assurance tests own final review.
    f.w.team.followthrough.advance = async () => {};
    await writeFile(join(f.cwd, 'facts.txt'), '涌现支持终端多窗口协作。');
    f.ctx.effect(() =>
      f.ctx.tools.register(
        defineTool({
          name: 'read',
          description: 'read fixture facts',
          parameters: { file_path: { type: 'string', required: true } },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: (args) => readFile(join(f.cwd, args.file_path), 'utf8'),
        }),
      ),
    );
    const original = f.provider.stream.bind(f.provider);
    let count = 0;
    let afterAnswer: ReturnType<typeof c.planning.intake>;
    const analysis = {
      objective: '与另一窗口协同生成简单介绍',
      route: 'planned',
      intent: 'execute',
      reason: '用户要求协作交付',
      acceptance: ['result.txt 有介绍内容'],
      constraints: ['只写 result.txt'],
      questions: ['介绍只写中文，还是中英双语？'],
    };
    f.provider.stream = async function* (request): AsyncIterable<StreamChunk> {
      if (JSON.stringify(request.messages).includes('[Emergence task ')) {
        yield* original(request);
        return;
      }
      const n = count++;
      if (n === 0) yield* call('emergence_analyze', analysis);
      else if (n === 1)
        yield* call('ask_user_question', {
          questions: [
            {
              id: 'language',
              question: analysis.questions[0],
              options: [{ label: '仅中文' }, { label: '中英双语' }],
            },
          ],
        });
      else if (n === 2) {
        afterAnswer = structuredClone(c.planning.intake());
        yield* call('emergence_analyze', {
          objective: analysis.objective,
          route: 'planned',
          intent: 'execute',
          reason: '用户已选择仅中文，继续原协作任务',
          changes: [
            {
              action: 'add',
              kind: 'constraint',
              text: '仅中文',
              sourceId: c.planning.intake()!.source!.admittedIds![0],
              reason: '本轮真实用户选择',
            },
          ],
        });
      } else if (n === 3) yield* call('read', { file_path: 'facts.txt' });
      else if (n === 4) {
        const state = c.planning.intake()!;
        yield* call('emergence_plan_step', {
          requirementRevision: state.requirements!.revision,
          draftRevision: 0,
          step: {
            id: 'intro',
            objective: analysis.objective,
            role: 'developer',
            project: f.cwd,
            scope: ['result.txt'],
            capabilities: ['tool:write'],
            requirementIds: ['a1'],
            localCriteria: [{ requirementId: 'a1', text: 'result.txt 有介绍内容' }],
            purpose: 'delivery',
            dependsOn: [],
          },
        });
      } else if (n === 5) {
        const state = c.planning.intake()!;
        yield* call('emergence_plan_commit', {
          requirementRevision: state.requirements!.revision,
          draftRevision: state.draft!.draftRevision,
          reason: '用户答复已入原需求，交给执行窗口',
          evidence: ['read-clarification'],
        });
      } else yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(main.id, '请和另外一个窗口协作生成简单介绍。');
    await until(() => !!c.pending);
    const before = structuredClone(c.planning.intake()!);
    const pending = c.pending!;
    c.respondInteraction(pending.id, pending.version, { action: 'submit', selected: ['1'] });
    await c.agent.whenIdle();
    assert.equal(
      afterAnswer!.analysis,
      null,
      'The answered question must not leave analysis permanently locked',
    );
    assert.equal(
      afterAnswer!.autonomy!.startedAt,
      before.autonomy!.startedAt,
      'Answering must not renew planning time',
    );
    assert.deepEqual(afterAnswer!.inheritedRequirements, before.requirements);
    assert.equal(afterAnswer!.coordination, before.coordination);
    assert.notDeepEqual(afterAnswer!.source!.admittedIds, before.source!.admittedIds);
    assert.equal(f.w.collaboration.state.tasks.length, 1, JSON.stringify(c.planning.state(c.agent).value));
    await until(() => f.w.collaboration.state.tasks[0]?.status === 'needs_review');
    const tasks = f.w.collaboration.state.tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].target, worker.id);
    assert.equal(f.writes(), 1);
    assert.equal(await readFile(join(f.cwd, 'result.txt'), 'utf8'), 'persisted actual effect');
    assert.deepEqual(
      c.planning
        .intake()!
        .requirements!.items.filter((i) => i.kind === 'constraint')
        .map((i) => i.text),
      ['只写 result.txt', '仅中文'],
    );
  } finally {
    await f.close();
  }
});

test('cancelled and wrong-window answers do not unlock planning; stale clarification cannot change a new goal', async () => {
  const f = await executionFixture();
  try {
    await f.ctx.plugin(UserQuestions);
    await f.ctx.plugin(AskUser);
    const main = f.w.current;
    const c = main.controller!;
    const worker = await f.w.split('row');
    await f.w.setMaster(main.id);
    let count = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (count++ === 0)
        yield* call('emergence_analyze', {
          objective: '等待用户选择语言后写文件',
          route: 'planned',
          intent: 'clarify',
          reason: '语言待定',
          acceptance: ['文件内容正确'],
          constraints: ['只写 result.txt'],
          questions: ['用什么语言？'],
        });
      else if (count === 2)
        yield* call('ask_user_question', {
          questions: [
            { id: 'language', question: '用什么语言？', options: [{ label: '中文' }, { label: '英文' }] },
          ],
        });
      else yield { type: 'finish', reason: { kind: 'stop' } };
    };
    await f.w.send(main.id, '请协作写说明，先询问语言。');
    await until(() => !!c.pending);
    const before = structuredClone(c.planning.intake()!);
    const pending = c.pending!;
    assert.throws(() =>
      worker.controller!.respondInteraction(pending.id, pending.version, {
        action: 'submit',
        selected: ['1'],
      }),
    );
    assert.throws(() =>
      c.respondInteraction(pending.id, pending.version + 1, { action: 'submit', selected: ['1'] }),
    );
    assert.deepEqual(c.planning.intake()!.analysis, before.analysis);
    c.respondInteraction(pending.id, pending.version, { action: 'cancel' });
    await c.agent.whenIdle();
    assert.deepEqual(c.planning.intake()!.analysis, before.analysis);
    assert.equal(f.w.collaboration.state.tasks.length, 0);
    assert.equal(f.writes(), 0);
    assert.equal(
      c.planning.resumesDraft(c.agent, '继续规划'),
      false,
      'An unanswered question must not resume the stale draft',
    );

    const late = c.planning.captureClarification(c.agent)!;
    assert.ok(late);
    await c.planning.admit(c.agent, [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '换个新任务，检查项目配置' }],
      }),
    ]);
    const next = c.planning.state(c.agent).value;
    await assert.rejects(late('中文'), /需求已变化/);
    assert.equal(c.planning.state(c.agent).value, next);
  } finally {
    await f.close();
  }
});
