import { ImageRenderable, NativeImage, type CliRenderer } from '@opentui/core';
import { aggregateRgba, aggregateSize, type AggregateState } from './aggregate-art.ts';

/** Real terminal graphics, never a coarse blocks approximation of the approved circles. */
export function createAggregateImage(renderer: CliRenderer) {
  const image = new ImageRenderable(renderer, {
    width: 8,
    height: 3,
    flexShrink: 0,
    marginRight: 2,
    fit: 'fit',
    protocol: 'auto',
    visible: false,
  });
  let signature = '';
  return {
    image,
    supported: () => image.effectiveProtocol !== 'blocks' && !image.loadError,
    paint(state: AggregateState, tick: number, background: string, monochrome: boolean) {
      const next = `${state}:${state === 'thinking' ? tick : 0}:${background}:${monochrome}`;
      if (signature === next) return;
      const source = NativeImage.fromRgba(
        aggregateRgba(state, tick, background, monochrome),
        aggregateSize,
        aggregateSize,
        undefined,
        { owner: renderer.nativeScene.resourceContext },
      );
      try {
        image.source = source;
        signature = next;
      } finally {
        source.dispose();
      }
    },
  };
}
