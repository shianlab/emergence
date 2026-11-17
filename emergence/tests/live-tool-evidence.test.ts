import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveFileEvidence } from './fixtures/live-tool-evidence.ts';

const success = [
  '┌ 工具 write\n{}',
  '└ 完成\nCreated file',
  '┌ 工具 read\n{}',
  '└ 完成\nEMERGENCE_CORE6_FILE',
];
const guard = ['┌ 工具 write\n{}', '└ 失败\n内置核心要求先完成目标分析：请主动调用 emergence_analyze'];
test('live evidence requires successful ordered file receipts', () => {
  assert.deepEqual(liveFileEvidence(success), { guardRecoveries: 0 });
  assert.throws(() => liveFileEvidence(['┌ 工具 write', '┌ 工具 read', '涌现 › EMERGENCE_CORE6_FILE']));
});
test('live evidence records one analysis guard followed by successful recovery', () => {
  assert.deepEqual(liveFileEvidence([...guard, '┌ 工具 emergence_analyze', '└ 完成\n{}', ...success]), {
    guardRecoveries: 1,
  });
});
test('live evidence never hides unknown or repeated failures', () => {
  assert.throws(() => liveFileEvidence(['┌ 工具 write', '└ 失败\npermission denied', ...success]));
  assert.throws(() =>
    liveFileEvidence([...guard, ...guard, '┌ 工具 emergence_analyze', '└ 完成', ...success]),
  );
});
test('live evidence rejects unresolved guards and reads before writes', () => {
  assert.throws(() => liveFileEvidence([...guard, ...success]));
  assert.throws(() =>
    liveFileEvidence(['┌ 工具 read', '└ 完成\nEMERGENCE_CORE6_FILE', '┌ 工具 write', '└ 完成']),
  );
});
