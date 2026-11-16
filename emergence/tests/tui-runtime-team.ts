import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { teamFeedback } from '../src/app/tui/team-feedback.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { WorkspaceController } from '../src/app/workspace.ts';
import { executionFixture } from './fixtures/core-execution.ts';

const f = await executionFixture(),
  test = await createTestRenderer({ width: 140, height: 42, useMouse: true });
let ui: ReturnType<typeof mountWorkspaceUI> | undefined, restored: WorkspaceController | undefined;
const envTerm = process.env.TERM,
  envColor = process.env.NO_COLOR;
delete process.env.NO_COLOR;
process.env.TERM = 'xterm-256color';
const flush = async () => {
  await test.flush();
  await test.renderOnce();
  await test.renderOnce();
};
try {
  const first = f.w.focused;
  await f.w.split('row');
  ui = mountWorkspaceUI(test.renderer, f.w, () => {});
  await flush();
  const view = ui.views.get(first)!;
  view.input.setText('草稿保持');
  await flush();
  await test.mockMouse.click(view.box.x + 2, view.box.y, 2);
  await flush();
  assert.ok(ui.paneMenu.box.visible, 'right click opens team menu');
  const menu = ui.paneMenu.box;
  await test.mockMouse.click(menu.x + 4, menu.y + 1);
  await flush();
  assert.equal(f.w.collaboration.state.master, first);
  assert.equal(f.w.collaboration.state.mode, 'collaborate');
  assert.equal(f.w.collaboration.state.workers.length, 1);
  assert.equal(view.input.plainText, '草稿保持');
  assert.equal(Math.round(view.box.borderColor.r * 255), 200);
  const worker = [...f.w.panes.values()].find((p) => p.id !== first)!,
    workerView = ui.views.get(worker.id)!;
  const priorPermission = worker.controller!.permissionMode;
  await test.mockMouse.click(workerView.box.x + 2, workerView.box.y, 2);
  await flush();
  await test.mockMouse.click(menu.x + 4, menu.y + 4);
  await flush();
  assert.equal(worker.rolePreference, 'developer', 'role preference can be selected directly with the mouse');
  assert.equal(worker.controller!.permissionMode, priorPermission, 'a preference never grants permission');
  const added = await f.w.split('column');
  assert.ok(f.w.collaboration.state.workers.includes(added.id));
  f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  await f.w.send(first, '帮我做一个简单页面');
  await f.w.panes.get(first)!.controller!.agent.whenIdle();
  assert.equal(
    f.w.panes.get(first)!.controller!.planning.intake()?.route,
    'planned',
    'master tasks automatically route into planning',
  );
  await flush();
  assert.ok(test.captureCharFrame().includes('[主控 · ' + teamFeedback(f.w).label), test.captureCharFrame());
  await mkdir('../artifacts/runtime-team', { recursive: true });
  await writeFile('../artifacts/runtime-team/native.txt', test.captureCharFrame());
  ui.dispose();
  ui = undefined;
  await f.w.close();
  restored = new WorkspaceController(f.ctx, f.launch);
  await restored.initialize();
  assert.equal(restored.collaboration.state.master, first);
  assert.equal(restored.collaboration.state.autoWorkers, true);
  await restored.clearMaster();
  assert.equal(restored.collaboration.state.mode, 'independent');
  assert.equal(restored.collaboration.state.master, undefined);
  await writeFile(
    '../artifacts/runtime-team/native.json',
    JSON.stringify(
      {
        passed: true,
        rightClick: true,
        mouseChoose: true,
        redMaster: true,
        draftPreserved: true,
        newWindowJoins: true,
        automaticMasterPlanning: true,
        persistedTeam: true,
        returnIndependent: true,
      },
      null,
      2,
    ),
  );
  console.log('PASS native mouse team controls, red border, automatic planning, drafts and restart');
} finally {
  ui?.dispose();
  await restored?.close();
  await test.dispose();
  await f.close();
  if (envTerm === undefined) delete process.env.TERM;
  else process.env.TERM = envTerm;
  if (envColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = envColor;
}
