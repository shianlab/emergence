import { palette } from '../../core/domain/ui-preferences.ts';
import type { WorkspaceController } from '../workspace.ts';
import { type AggregateState } from './aggregate-art.ts';
import { createAggregateImage } from './aggregate-image.ts';

const frameMs = 140;

export function workspaceBrand(
  workspace: Pick<WorkspaceController, 'current' | 'focused' | 'launch'>,
  aggregate: ReturnType<typeof createAggregateImage>,
) {
  let brandSession = '',
    brandWasBusy = false,
    brandDoneUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;

  function schedule(at: number | undefined, now: number) {
    if (deadline === at) return;
    clearTimeout(timer);
    deadline = at;
    timer =
      at === undefined
        ? undefined
        : setTimeout(
            () => {
              deadline = undefined;
              sync();
            },
            Math.max(1, at - now),
          );
  }

  function sync() {
    const controller = workspace.current.controller,
      ui = workspace.launch.appConfig.ui,
      now = Date.now();
    const session = controller?.id ?? workspace.focused;
    if (session !== brandSession) {
      brandSession = session;
      brandWasBusy = false;
      brandDoneUntil = 0;
    }
    if (
      brandWasBusy &&
      !controller?.busy &&
      !controller?.pending &&
      !controller?.lastError &&
      controller?.notice === '本轮已完成'
    )
      brandDoneUntil = now + 1800;
    brandWasBusy = Boolean(controller?.busy);
    if (!aggregate.image.visible || !aggregate.supported()) {
      schedule(undefined, now);
      return;
    }
    const state: AggregateState =
      workspace.current.error || controller?.lastError
        ? 'error'
        : controller?.pending
          ? 'tool'
          : controller?.busy
            ? controller.activity.tools.length
              ? 'tool'
              : 'thinking'
            : now < brandDoneUntil
              ? 'done'
              : 'idle';
    const monochrome = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
    const animated =
      state === 'thinking' &&
      !ui.reducedMotion &&
      !monochrome &&
      process.env.EMERGENCE_REDUCED_MOTION !== '1';
    const frame = Math.floor(now / frameMs);
    aggregate.paint(state, animated ? frame % 20 : 0, palette(ui).background, monochrome);
    schedule(
      animated ? (frame + 1) * frameMs : state === 'done' && !monochrome ? brandDoneUntil : undefined,
      now,
    );
  }
  return { sync, dispose: () => schedule(undefined, Date.now()) };
}
