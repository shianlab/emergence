import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

const dir = resolve('../artifacts/core-phase5');
await mkdir(dir, { recursive: true });
const f = await executionFixture(),
  w = f.w,
  pane = w.current,
  c = pane.controller!;
const native = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true }),
  ui = mountWorkspaceUI(native.renderer, w, () => {});
const checks: Record<string, boolean> = {},
  frames: Record<string, string> = {};
const open = async (text: string) => {
  const command = w.send(pane.id, text);
  await until(() => !!c.pending);
  await native.flush();
  await delay(400);
  return { command };
};
try {
  const view = ui.views.get(pane.id)!;
  view.input.setText('/记忆');
  await native.flush();
  assert.equal(view.commands.selected?.command, '/memory');
  view.input.setText('/审查');
  await native.flush();
  assert.equal(view.commands.selected?.command, '/audit');
  view.input.setText('');
  await w.send(pane.id, '/memory propose project fact "项目使用中文交流和独立验收"');
  const entry = (await c.memory.store.list(await c.memory.identity(), true))[0];
  assert.ok(w.overlay.includes('尚未生效'));
  let pending = await open(`/memory approve ${entry.id}`);
  frames.preview = native.captureCharFrame();
  native.mockInput.pressEnter();
  await native.flush();
  await pending.command;
  assert.equal((await c.memory.search()).length, 0);
  checks.defaultCancel = true;
  pending = await open(`/memory approve ${entry.id}`);
  native.mockInput.pressArrow('down');
  await native.flush();
  native.mockInput.pressEnter();
  await native.flush();
  await pending.command;
  assert.equal((await c.memory.search()).length, 1);
  checks.nativeApproval = true;
  pending = await open(`/memory correct ${entry.id} "纠正内容仍需重新批准"`);
  native.mockInput.pressEscape();
  await delay(100);
  await native.flush();
  await pending.command;
  assert.equal((await c.memory.search())[0].content, entry.content);
  checks.escapePreservesOriginal = true;
  await w.send(pane.id, `/memory history ${entry.id}`);
  assert.ok(w.overlay.includes('approve'));
  pending = await open(`/memory forget ${entry.id}`);
  native.resize(60, 24);
  await native.flush();
  frames.narrow = native.captureCharFrame();
  assert.ok(frames.narrow.includes('确认') || frames.narrow.includes('取消'));
  native.mockInput.pressArrow('down');
  await native.flush();
  native.mockInput.pressEnter();
  await native.flush();
  await pending.command;
  assert.equal((await c.memory.search()).length, 0);
  checks.narrowForget = true;
  await w.send(pane.id, '/memory status');
  assert.ok(w.overlay.includes('Graphify'));
  await w.send(pane.id, '/audit');
  assert.ok(w.overlay.includes('暂无'));
  checks.chineseMenusAndHonestExternalStatus = true;
  await writeFile(join(dir, 'native.json'), JSON.stringify({ passed: true, checks, frames }, null, 2));
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, error: String(error), checks, frames, frame: native.captureCharFrame() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ui.dispose();
  await f.close();
  await native.dispose();
}
