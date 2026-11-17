import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { approvalFixture } from './fixtures/workspace-approvals.ts';
import { until } from './fixtures/core-execution.ts';

const f = await approvalFixture(),
  test = await createTestRenderer({ width: 160, height: 46, useMouse: true });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined;
const flush = async () => {
  await test.flush();
  await test.renderOnce();
  await test.renderOnce();
};
try {
  f.w.focus(f.master.id);
  ui = mountWorkspaceUI(test.renderer, f.w, () => {});
  await flush();
  const draft = ui.views.get(f.master.id)!.input;
  draft.setText('主控草稿保持不变');
  const tasks = await f.start();
  await flush();
  const entries = f.w.interactions.list();
  assert.equal(f.w.focused, f.master.id);
  await f.w.send(f.master.id, '/approvals');
  await flush();
  assert.ok(ui.commandList.box.visible);
  assert.equal(f.writes(), 0);
  test.mockInput.pressArrow('down');
  test.mockInput.pressEnter();
  await flush();
  assert.equal(f.w.focused, f.workers[1].id);
  assert.equal(f.w.interactions.list().length, 3);
  await delay(400);
  test.mockInput.pressArrow('down');
  test.mockInput.pressEnter();
  await flush();
  await until(() => !f.workers[1].controller!.pending);
  f.w.focus(f.master.id);
  await f.w.send(f.master.id, '/approvals');
  await flush();
  await test.mockMouse.click(ui.commandList.box.x + 2, ui.commandList.box.y + 1);
  await flush();
  assert.equal(f.w.focused, f.workers[0].id);
  await delay(400);
  test.mockInput.pressEnter();
  await flush();
  await until(() => f.writes() === 1);
  f.w.focus(f.master.id);
  test.resize(60, 24);
  await flush();
  await f.w.send(f.master.id, '/approvals');
  await flush();
  test.mockInput.pressEnter();
  await flush();
  assert.equal(f.w.focused, f.workers[2].id);
  await delay(400);
  test.mockInput.pressEscape();
  await delay(100);
  await flush();
  await until(() => tasks.every((t) => !!t.endedAt));
  assert.equal(f.w.interactions.list().length, 0);
  assert.equal(draft.plainText, '主控草稿保持不变');
  assert.equal(f.writes(), 1);
  for (const [i, outcome] of ['allowed-once', 'rejected', 'cancelled'].entries()) {
    const decided = f.workers[i]
      .controller!.agent.session.snapshotEvents()
      .find((e) => e.type === 'approval/decided' && e.data.id === entries[i].ref.id);
    assert.equal(decided?.type === 'approval/decided' && decided.data.outcome, outcome);
  }
  // Capture immediately after the renderer has settled, before filesystem awaits
  // allow the next animation frame to acquire the native output buffer.
  await flush();
  const frame = test.captureCharFrame();
  await mkdir('../artifacts/r3', { recursive: true });
  await writeFile(
    '../artifacts/r3/tui.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          '鼠标打开全部待办',
          '键盘选择请求所属窗口',
          '鼠标选择请求所属窗口',
          'Enter允许',
          '方向键拒绝',
          'Esc取消',
          '窄屏',
          '草稿保留',
          '真实原生审批回执',
        ],
        frame,
      },
      null,
      2,
    ),
  );
  console.log(
    'R3 native TUI: mouse navigation, Enter allow, keyboard reject, Esc cancel, narrow screen and draft retention passed',
  );
} finally {
  ui?.dispose();
  await test.dispose();
  await f.close();
}
