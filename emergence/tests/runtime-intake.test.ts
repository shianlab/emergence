import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeIdentity } from '../src/app/runtime-identity.ts';
import { executionFixture } from './fixtures/core-execution.ts';

for (const intent of ['discuss', 'clarify'] as const)
  test(`${intent} analysis blocks effects and manual plan execution; subsequent execution input can proceed`, async () => {
    const f = await executionFixture();
    try {
      f.w.current.controller!.setPermissionMode('auto');
      let n = 0,
        execute = false;
      f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
        const step = n++;
        if (step > 1) {
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const name = step ? 'write' : 'emergence_analyze';
        const args = step
          ? { file_path: 'result.txt', content: 'approved followup' }
          : {
              objective: '整理欢迎语需求',
              reason: '先确认用途再实施',
              route: 'focused',
              intent: execute ? 'execute' : intent,
              constraints: ['仅当前文件'],
              acceptance: ['中文欢迎语'],
              questions: !execute && intent === 'clarify' ? ['面向哪类用户？'] : [],
            };
        const id = ToolCallId(`intent-${execute}-${step}`),
          raw = JSON.stringify(args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      };
      const c = f.w.current.controller!;
      await f.w.send(f.w.focused, '先聊一聊欢迎语，暂时不要改文件');
      await c.agent.whenIdle();
      assert.equal(c.planning.intake()?.analysis?.intent, intent);
      assert.equal(f.writes(), 0);
      assert.match(c.planning.label, intent === 'discuss' ? /仅讨论，不执行/ : /等待关键补充/);
      await assert.rejects(c.planning.readyPlan(), /仅讨论或存在待确认/);
      n = 0;
      execute = true;
      await f.w.send(f.w.focused, '面向新用户，现在把欢迎语换成中文');
      await c.agent.whenIdle();
      assert.equal(c.planning.intake()?.analysis?.intent, 'execute');
      assert.equal(f.writes(), 1);
    } finally {
      await f.close();
    }
  });

test('live identity follows actual model and core switch; every normal input reaches native intake', async () => {
  const f = await executionFixture();
  try {
    let request = '';
    f.provider.stream = async function* (options): AsyncIterable<StreamChunk> {
      request = JSON.stringify(options.messages);
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const c = f.w.current.controller!;
    await f.w.send(f.w.focused, '你当前是什么模型，内置能力有哪些？');
    await c.agent.whenIdle();
    const facts = runtimeIdentity(c, c.agent);
    assert.equal(facts.harness, 'Emergence Harness');
    assert.equal(facts.model.requestedModel, c.model.model);
    assert.ok(request.includes('Emergence Harness') && request.includes(c.model.model));
    assert.ok(!request.includes('powered by DeepSeek Harness'));
    assert.equal(facts.core.intake?.route, 'direct');
    assert.match(c.planning.label, /已自动分流/);
    await f.w.send(f.w.focused, '/core off');
    assert.equal(runtimeIdentity(c, c.agent).core.enabled, false);
    assert.match(c.planning.label, /已关闭/);
  } finally {
    await f.close();
  }
});

test('semantic analysis upgrades an unrecognized task and enforces native plan admission before effects', async () => {
  const f = await executionFixture();
  try {
    let n = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      const step = n++;
      if (step > 1) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const name = step ? 'write' : 'emergence_analyze';
      const args = step
        ? { file_path: 'result.txt', content: 'must not write before plan' }
        : { objective: '梳理登录流程并校验交互', reason: '自然语言隐含多个改动与验证步骤', route: 'planned' };
      const id = ToolCallId('analysis-' + step),
        raw = JSON.stringify(args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const c = f.w.current.controller!;
    await f.w.send(f.w.focused, '把现有登录体验打磨得顺手些');
    await c.agent.whenIdle();
    assert.equal(c.planning.intake()?.route, 'planned');
    assert.equal(f.writes(), 0);
    assert.match(c.planning.label, /目标已分析/);
    assert.ok(
      c.agent.session.snapshotEvents().some((e) => e.type === 'tool/result' && e.data.message.isError),
    );
    assert.match(await c.planning.describe(), /梳理登录流程/);
  } finally {
    await f.close();
  }
});

test('a task without routing keywords cannot perform a write before core analysis', async () => {
  const f = await executionFixture();
  try {
    let n = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (n++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('unclassified-write'),
        name = 'write',
        raw = JSON.stringify({ file_path: 'result.txt', content: 'must be blocked' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await f.w.send(f.w.focused, '把欢迎语换成中文');
    await f.w.current.controller!.agent.whenIdle();
    assert.equal(
      f.w.current.controller!.planning.intake()?.route,
      'direct',
      'regression exercises an unrecognized work request',
    );
    assert.equal(
      f.writes(),
      0,
      'native core must intercept implementation even when keyword routing misses intent',
    );
  } finally {
    await f.close();
  }
});
