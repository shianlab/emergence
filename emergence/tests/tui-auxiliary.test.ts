import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auxiliaryInfo } from '../src/app/tui/auxiliary-info.ts';
import { sessionFooter } from '../src/app/tui/workspace-chrome.ts';
import stringWidth from 'string-width';
const base = {
  session: 'one',
  busy: false,
  pending: false,
  queued: 0,
  shared: 1,
  expanded: false,
  en: false,
  now: 1000,
};
test('unknown notices cannot collide with JavaScript object property names', () => {
  for (const notice of ['constructor', 'toString', '__proto__'])
    assert.equal(auxiliaryInfo({ ...base, notice }).persistent, notice);
});
test('narrow footers preserve usage values and missing-receipt markers', () => {
  for (const label of [
    'Tokens —（未返回）',
    'Tokens ≥12,345（部分）',
    'Tokens — (unreported)',
    'Tokens ≥12,345 (partial)',
  ]) {
    for (const width of [24, 32, 48, 80]) {
      const footer = sessionFooter('C:\\中文🙂项目\\长目录', label, width);
      assert.ok(stringWidth(footer) <= width);
      assert.ok(footer.includes(label.includes('≥') ? 'Tokens ≥12,345' : 'Tokens —'));
      assert.ok(!/[\uD800-\uDBFF]$/.test(footer));
    }
  }
});
test('routine receipt expires, then merges idle and shared status', () => {
  const first = auxiliaryInfo({ ...base, notice: '本轮已完成' });
  assert.equal(first.receipt, '✓ 本轮已完成');
  assert.equal(first.mergeReady, false);
  const later = auxiliaryInfo({ ...base, notice: '本轮已完成', now: 5001 }, first.clock);
  assert.equal(later.receipt, '');
  assert.equal(later.mergeReady, true);
});
test('active states replace routine receipts without hiding queued/approval state', () => {
  for (const state of [{ busy: true }, { pending: true }, { queued: 2 }, { error: '执行失败' }]) {
    const actual = auxiliaryInfo({ ...base, notice: '已提交', ...state });
    assert.equal(actual.receipt, '');
    assert.equal(actual.mergeReady, false);
  }
});
test('unknown notices and conflicts never expire, including during confirmation', () => {
  const state = {
    ...base,
    pending: true,
    notice: '文件冲突：请先协调修改',
    globalNotice: '磁盘写入失败',
    error: '授权失败',
  };
  const first = auxiliaryInfo(state);
  const later = auxiliaryInfo({ ...state, now: 999999 }, first.clock);
  assert.equal(later.persistent, '授权失败\n文件冲突：请先协调修改\n磁盘写入失败');
});
test('receipt clocks belong to a session and reset on new notice', () => {
  const first = auxiliaryInfo({ ...base, notice: '已提交' });
  assert.equal(
    auxiliaryInfo({ ...base, session: 'two', notice: '已提交', now: 99999 }, first.clock).receipt,
    '已提交',
  );
  assert.equal(
    auxiliaryInfo({ ...base, notice: '本轮已完成', now: 99999 }, first.clock).receipt,
    '✓ 本轮已完成',
  );
});
test('shared detail is optional, deduplication retains full command output', () => {
  const text = '第一行\n第二行\n第三行';
  const info = auxiliaryInfo({ ...base, expanded: true, notice: text, globalNotice: text });
  assert.equal(info.persistent, text);
  assert.match(info.shared, /同一目录/);
  assert.equal(info.mergeReady, false);
  assert.equal(auxiliaryInfo({ ...base, shared: 0, expanded: true }).shared, '');
});
