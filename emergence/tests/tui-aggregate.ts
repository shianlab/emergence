import { createTestRenderer } from '@opentui/core/testing';
import assert from 'node:assert/strict';
import { aggregateRgba, aggregateSize } from '../src/app/tui/aggregate-art.ts';
import { createAggregateImage } from '../src/app/tui/aggregate-image.ts';

const background = '#111111';
const idle = aggregateRgba('idle', 0, background);
const thinking = aggregateRgba('thinking', 10, background);
const pixel = (data: Uint8Array, x: number, y: number) => {
  const at =
    (Math.floor(((y - 180) * aggregateSize) / 640) * aggregateSize +
      Math.floor(((x - 180) * aggregateSize) / 640)) *
    4;
  return [...data.slice(at, at + 3)];
};
assert.deepEqual(pixel(idle, 656, 346), [238, 238, 238]);
assert.deepEqual(pixel(idle, 525, 215), [17, 17, 17], 'circle corner must stay empty');
assert.deepEqual(pixel(idle, 515, 345), [17, 17, 17], 'separate satellite gap');
assert.deepEqual(pixel(idle, 356, 355), [238, 238, 236]);
assert.deepEqual(pixel(idle, 500, 500), [17, 17, 17], 'concave neck retains reference shape');
for (let y = 105; y < aggregateSize; y++) {
  assert.deepEqual(
    thinking.slice(y * aggregateSize * 4, (y + 1) * aggregateSize * 4),
    idle.slice(y * aggregateSize * 4, (y + 1) * aggregateSize * 4),
    'body does not move',
  );
}
assert.notDeepEqual(pixel(thinking, 656, 346), pixel(idle, 656, 346));
assert.deepEqual(aggregateRgba('idle', 18, background), idle, 'idle is static');
assert.deepEqual(pixel(aggregateRgba('error', 0, background, true), 656, 346), [238, 238, 236]);

const test = await createTestRenderer({ width: 80, height: 30 });
const brand = createAggregateImage(test.renderer);
test.renderer.root.add(brand.image);
try {
  assert.equal(brand.supported(), false, 'headless/unsupported terminals must not use block approximations');
  for (const state of ['idle', 'thinking', 'tool', 'done', 'error'] as const) {
    brand.paint(state, 10, background, false);
    await brand.image.loadPromise;
    assert.equal(brand.image.loadError, null);
    assert.equal(brand.image.image?.width, aggregateSize);
  }
  brand.image.protocol = 'kitty';
  assert.equal(brand.supported(), true);
  const fit = brand.image.getFittedSize(8, 3, 2);
  assert.deepEqual(fit, { width: 6, height: 3 }, 'square graphic within three text rows');
  brand.image.visible = true;
  await test.renderOnce();
  test.resize(45, 20);
  await test.renderOnce();
} finally {
  await test.dispose();
}
console.log('Aggregate: approved outline, fixed body, states, native image lifetime and sizing passed.');
