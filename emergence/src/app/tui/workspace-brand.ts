import { palette } from '../../core/domain/ui-preferences.ts';
import type { WorkspaceController } from '../workspace.ts';
import { type AggregateState } from './aggregate-art.ts';
import { createAggregateImage } from './aggregate-image.ts';
export function workspaceBrand(
  workspace: Pick<WorkspaceController, 'current' | 'focused' | 'launch'>,
  aggregate: ReturnType<typeof createAggregateImage>,
  isDisposed: () => boolean,
) {
  const headerLogo = aggregate.image;
  let brandSession = '',
    brandWasBusy = false,
    brandDoneUntil = 0,
    brandPaint = '';
  function paintBrand() {
    if (isDisposed() || !headerLogo.visible) return;
    const controller = workspace.current.controller,
      ui = workspace.launch.appConfig.ui,
      colors = palette(ui);
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
      brandDoneUntil = Date.now() + 1800;
    brandWasBusy = Boolean(controller?.busy);
    const state: AggregateState =
      workspace.current.error || controller?.lastError
        ? 'error'
        : controller?.pending
          ? 'tool'
          : controller?.busy
            ? controller.activity.tools.length
              ? 'tool'
              : 'thinking'
            : Date.now() < brandDoneUntil
              ? 'done'
              : 'idle';
    const monochrome = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';
    const tick =
      ui.reducedMotion || monochrome || process.env.EMERGENCE_REDUCED_MOTION === '1'
        ? 0
        : Math.floor(Date.now() / 140) % 20;
    const signature = `${state}:${tick}:${colors.background}:${monochrome}`;
    if (signature === brandPaint) return;
    brandPaint = signature;
    aggregate.paint(state, tick, colors.background, monochrome);
  }
  return paintBrand;
}
