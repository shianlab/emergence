import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { executionFixture, until } from './fixtures/core-execution.ts';

const dir = resolve('../artifacts/core-phase4');
await mkdir(dir, { recursive: true });
const f = await executionFixture(),
  w = f.w,
  master = w.current,
  worker = await w.split('row');
w.collaboration.configure(master.id, [worker.id]);
const blocker = await w.collaboration.enqueue(master.id, worker.id, 'native-blocker', 'fixture:write', [], {
  role: 'developer',
  scope: ['result.txt'],
  acceptance: ['核对内容'],
});
await until(() => blocker.status === 'needs_review');
const task = await w.collaboration.enqueue(master.id, worker.id, 'native-pending', 'fixture:write', [
  blocker.id,
]);
w.collaboration.pause(true);
Object.assign(task, { status: 'interrupted' });
await w.save();
w.focused = master.id;
const native = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true }),
  ui = mountWorkspaceUI(native.renderer, w, () => {});
const frames: Record<string, string> = {},
  checks: Record<string, boolean> = {};
const open = async () => {
  const command = w.send(master.id, `/recover retry ${task.id} "已核对尚未执行，现在允许新尝试"`);
  await until(() => !!master.controller!.pending);
  await native.flush();
  await delay(400);
  return { command };
};
try {
  ui.views.get(master.id)!.input.setText('/中断');
  await native.flush();
  assert.equal(ui.views.get(master.id)!.commands.selected?.command, '/recover');
  ui.views.get(master.id)!.input.setText('');
  await native.flush();
  let decision = await open();
  frames.default = native.captureCharFrame();
  assert.equal(master.controller!.pending!.options[0].value, 'n');
  native.mockInput.pressEnter();
  await native.flush();
  await decision.command;
  assert.equal(w.collaboration.state.tasks.length, 2);
  checks.enterCancelsByDefault = true;
  decision = await open();
  native.mockInput.pressEscape();
  await delay(100);
  await native.flush();
  await decision.command;
  assert.equal(w.collaboration.state.tasks.length, 2);
  checks.escapeCancels = true;
  w.collaboration.pause(false);
  decision = await open();
  native.resize(60, 24);
  await native.flush();
  frames.narrow = native.captureCharFrame();
  assert.ok(frames.narrow.includes('确认') || frames.narrow.includes('取消'));
  native.mockInput.pressArrow('down');
  await native.flush();
  native.mockInput.pressEnter();
  await native.flush();
  await decision.command;
  assert.equal(w.collaboration.state.tasks.length, 3);
  assert.equal(w.collaboration.state.tasks[2].recoveryOf, task.id);
  assert.equal(w.collaboration.state.tasks[2].status, 'queued');
  assert.equal(f.writes(), 1);
  checks.arrowAndEnterCreateOneAttemptWithDependencies = true;
  checks.chineseMenuAndNarrowDialog = true;
  await writeFile(join(dir, 'native.json'), JSON.stringify({ passed: true, checks, frames }, null, 2));
  console.log(JSON.stringify(checks));
} catch (error) {
  await writeFile(
    join(dir, 'native.json'),
    JSON.stringify(
      { passed: false, error: String(error), frames, frame: native.captureCharFrame() },
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
