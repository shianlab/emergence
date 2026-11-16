import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandTokens,
  geometry,
  leaves,
  removePane,
  resizeSplit,
  splitPane,
  type Layout,
} from '../src/app/layout.ts';

test('nested splits retain pane identities and cover separate rectangles', () => {
  let tree: Layout = { kind: 'pane', pane: 'a' };
  tree = splitPane(tree, 'a', 'b', 'row');
  tree = splitPane(tree, 'b', 'c', 'column');
  tree = splitPane(tree, 'c', 'd', 'row');
  assert.deepEqual(leaves(tree), ['a', 'b', 'c', 'd']);
  const { panes } = geometry(tree, { x: 0, y: 0, width: 140, height: 48 });
  for (const [id, a] of panes)
    for (const [other, b] of panes) {
      if (id !== other)
        assert.ok(
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        );
    }
  assert.deepEqual(leaves(removePane(tree, 'b')!), ['a', 'c', 'd']);
  if (tree.kind === 'split') {
    const changed = resizeSplit(tree, tree.id, 2);
    assert.equal(changed.kind === 'split' && changed.ratio, 0.85);
  }
});
test('Windows command paths preserve backslashes and quoted spaces', () => {
  assert.deepEqual(commandTokens('/split right "M:\\中文 项目" local'), [
    '/split',
    'right',
    'M:\\中文 项目',
    'local',
  ]);
  assert.deepEqual(commandTokens('/project M:\\project'), ['/project', 'M:\\project']);
  assert.throws(() => commandTokens('/project "unfinished'), /引号/);
});
