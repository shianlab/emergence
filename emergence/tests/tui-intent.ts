import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { ScrollBoxRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { MessageProjection, intentSummary } from '../src/app/tui/message-model.ts';
import { mountMessages } from '../src/app/tui/message-view.ts';
import { palettes } from '../src/core/domain/ui-preferences.ts';

const event = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1, data }) as SessionEvent;
const context = (seq: number, kind: string, text: string) =>
  event('user/message', seq, { source: { kind, name: 'example' }, content: [{ type: 'text', text }] });
const p = new MessageProjection('intent').load([
  context(0, 'user', '先讨论需求，不要写入'),
  context(1, 'runtime-context', 'DIRECTORY_PRIVATE'),
  context(2, 'emergence-instructions', 'PROJECT_RULES'),
  context(3, 'skill-catalog', '<system-reminder>'),
  context(4, 'skill-invocation', '真正使用的技能仍可查看'),
  event('tool/call', 5, {
    callId: 'analyze',
    name: 'emergence_analyze',
    arguments: '{"objective":"not the recorded objective"}',
  }),
  event('tool/result', 6, {
    message: {
      source: { callId: 'analyze' },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            analysis: {
              objective: '整理中文欢迎语需求',
              reason: '用户先讨论',
              intent: 'discuss',
              constraints: ['不改文件'],
              acceptance: ['方案可理解'],
              questions: [],
            },
          }),
        },
      ],
    },
  }),
  event('assistant/message', 7, {
    message: { content: [{ type: 'text', text: '可以先讨论欢迎语的目标用户。' }] },
  }),
]);
const test = await createTestRenderer({ width: 110, height: 55 });
const scroll = new ScrollBoxRenderable(test.renderer, { width: '100%', height: '100%', scrollY: true });
const feed = mountMessages(test.renderer, scroll, () => {});
scroll.add(feed.box);
test.renderer.root.add(scroll);
const original = JSON.stringify(p.items);
try {
  feed.update(p, '', palettes.dark, 106, false);
  await test.flush();
  const initial = test.captureCharFrame();
  assert.ok(initial.includes('背景资料 · 3 条'));
  assert.ok(
    !initial.includes('运行上下文') &&
      !initial.includes('项目指引') &&
      !initial.includes('<system-reminder>'),
  );
  assert.ok(initial.includes('技能 example') && initial.includes('先讨论需求'));
  for (const text of [
    '需求理解',
    '目标：整理中文欢迎语需求',
    '约束：不改文件',
    '验收：方案可理解',
    '待确认：无阻塞问题',
    '处理：先讨论，不执行',
  ])
    assert.ok(initial.includes(text), text);
  await test.mockMouse.click(feed.backgroundToggle.x + 1, feed.backgroundToggle.y);
  await test.flush();
  const expanded = test.captureCharFrame();
  assert.ok(
    expanded.includes('运行上下文') && expanded.includes('项目指引') && expanded.includes('技能目录'),
  );
  feed.command('context');
  await test.flush();
  assert.ok(!test.captureCharFrame().includes('运行上下文'));
  assert.equal(JSON.stringify(p.items), original, 'presentation never alters original history');
  const tool = p.items.find((i) => i.kind === 'tool')!;
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(intentSummary({ ...tool, status: 'error' }), undefined);
    assert.equal(intentSummary({ ...tool, status: 'running' }), undefined);
    assert.equal(intentSummary({ ...tool, result: 'invalid json' }), undefined);
  }
  feed.command('tools', 5);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('not the recorded objective'), 'raw arguments retained');
  feed.command('tools', 5);
  test.resize(42, 75);
  feed.update(p, '', palettes.dark, 38, false);
  await test.flush();
  assert.ok(test.captureCharFrame().includes('待确认：无阻塞问题'), 'analysis is not clipped to two lines');
  feed.command('context');
  const other = new MessageProjection('other').load([context(0, 'runtime-context', 'OTHER')]);
  feed.update(other, '', palettes.dark, 38, false);
  await test.flush();
  assert.ok(!test.captureCharFrame().includes('运行上下文'));
  await mkdir('../artifacts/intent-context', { recursive: true });
  await writeFile(
    '../artifacts/intent-context/tui.json',
    JSON.stringify(
      {
        passed: true,
        initial,
        expanded,
        nativeMouseToggle: true,
        originalHistoryPreserved: true,
        narrowAnalysisVisible: true,
        sessionIsolation: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS native background toggle and successful recorded intent summary, narrow screen and intact history',
  );
} finally {
  feed.dispose();
  await test.dispose();
}
