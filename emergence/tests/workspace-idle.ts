import { createHook } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTestRenderer } from '@opentui/core/testing';
import { WorkspaceController } from '../src/app/workspace.ts';
import { mountWorkspaceUI } from '../src/app/workspace-ui.ts';
import { defaultConfig } from '../src/core/domain/configuration.ts';
import { harness } from './fixtures/harness.ts';

class IdleProvider extends LlmAdapter {
  readonly entered = Promise.withResolvers<void>();
  readonly answer = Promise.withResolvers<void>();
  async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, defaultMaxTokens: 256 };
  }
  async *stream() {
    this.entered.resolve();
    await this.answer.promise;
    yield { type: 'finish', reason: { kind: 'stop' } } as const;
  }
}

const home = await mkdtemp(join(tmpdir(), 'emergence-workspace-idle-'));
const provider = new IdleProvider();
const ctx = await harness(home, ['deepseek'], provider);
const renderer = await createTestRenderer({ width: 110, height: 30 });
const config = structuredClone(defaultConfig);
config.models[0].apiKeyEnv = 'WORKSPACE_IDLE_FIXTURE';
process.env.WORKSPACE_IDLE_FIXTURE = 'fixture';
const originalColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;
const originalMotion = process.env.EMERGENCE_REDUCED_MOTION;
delete process.env.NO_COLOR;
delete process.env.EMERGENCE_REDUCED_MOTION;
process.env.TERM = 'xterm-256color';
const workspace = new WorkspaceController(ctx, {
  home,
  cwd: home,
  modelId: 'deepseek',
  appConfig: config,
  fresh: true,
});
const owned = new Set<number>();
let measuring = false;
let wakeups = 0;
let frames = 0;
const hook = createHook({
  init(id, type) {
    if (type !== 'Timeout') return;
    const caller = new Error().stack
      ?.split('\n')
      .find((line) => /workspace\b/.test(line) && !line.includes('workspace-idle.ts'));
    if (caller && /workspace-ui\.ts|workspace-(brand|refresh)\.ts/.test(caller)) owned.add(id);
  },
  before(id) {
    if (measuring && owned.has(id)) wakeups++;
  },
  destroy(id) {
    owned.delete(id);
  },
});
renderer.renderer.on('frame', () => {
  if (measuring) frames++;
});
await workspace.initialize();
hook.enable();
const ui = mountWorkspaceUI(renderer.renderer, workspace, () => {});
try {
  await renderer.renderOnce();
  await delay(600);
  const started = performance.now();
  const cpu = process.cpuUsage();
  measuring = true;
  await delay(5000);
  measuring = false;
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      elapsedMs: Math.round(performance.now() - started),
      wakeups,
      frames,
      cpuMs: (used.user + used.system) / 1000,
      graphics: ui.headerLogo.visible,
    }),
  );
  if (!process.argv.includes('--baseline')) {
    assert.equal(wakeups, 0, 'idle workspace must not poll');
    assert.equal(frames, 0, 'unchanged scroll hints must not request another frame');
    ui.headerLogo.protocol = 'kitty';
    renderer.renderer.emit('capabilities');
    await ui.headerLogo.loadPromise;
    assert.equal(ui.headerLogo.visible, true, 'late capability discovery enables the logo');
    const controller = workspace.current.controller!;
    const view = ui.views.get(workspace.focused)!;
    const status = () => view.status.chunks.map((chunk) => chunk.text).join('');
    await workspace.send(workspace.focused, 'Test status clock');
    await provider.entered.promise;
    const moving = ui.headerLogo.source;
    await delay(350);
    assert.notEqual(ui.headerLogo.source, moving, 'right dot advances while thinking');
    config.ui.reducedMotion = true;
    ui.refresh();
    const reduced = ui.headerLogo.source;
    await delay(1250);
    assert.equal(ui.headerLogo.source, reduced, 'reduced motion stops graphics ticks');
    assert.match(status(), /已运行 [1-9]\d* 秒/, 'elapsed time remains live');
    config.ui.reducedMotion = false;
    process.env.NO_COLOR = '1';
    ui.refresh();
    const gray = ui.headerLogo.source;
    await delay(350);
    assert.equal(ui.headerLogo.source, gray, 'no-color logo stays static');
    provider.answer.resolve();
    await controller.agent.whenIdle();
    assert.match(status(), /本轮已完成/);
    await delay(4200);
    assert.doesNotMatch(status(), /本轮已完成/, 'routine receipt expires without a user action');
    renderer.resize(34, 18);
    await renderer.renderOnce();
    assert.equal(ui.headerLogo.visible, false, 'small terminals retain the text brand');
    console.log(
      'active clock, animation, reduced motion, monochrome, receipt expiration and narrow layout passed',
    );
  }
} finally {
  provider.answer.resolve();
  ui.dispose();
  hook.disable();
  await workspace.close();
  await ctx.fiber.dispose();
  await renderer.dispose();
  if (originalColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalColor;
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
  if (originalMotion === undefined) delete process.env.EMERGENCE_REDUCED_MOTION;
  else process.env.EMERGENCE_REDUCED_MOTION = originalMotion;
}
