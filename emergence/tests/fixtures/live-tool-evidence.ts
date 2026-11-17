import assert from 'node:assert/strict';

/** Accept one explicitly recovered analysis guard, never an arbitrary failed tool. */
export function liveFileEvidence(lines: string[]) {
  let tool = '',
    analyzed = false,
    written = false,
    read = false,
    guardRecoveries = 0;
  for (const line of lines) {
    if (line.startsWith('┌ 工具 ')) tool = line.slice(5).split('\n')[0];
    else if (line.startsWith('└ 失败')) {
      assert.ok(
        tool === 'write' &&
          !analyzed &&
          !written &&
          guardRecoveries === 0 &&
          line.includes('内置核心要求先完成目标分析：请主动调用 emergence_analyze'),
        'Unexpected or repeated failed tool in real file chain',
      );
      guardRecoveries++;
      tool = '';
    } else if (line.startsWith('└ 完成')) {
      if (tool === 'emergence_analyze') analyzed = true;
      if (tool === 'write') {
        assert.ok(!guardRecoveries || analyzed, 'Write succeeded before analysis guard recovery');
        written = true;
      }
      if (tool === 'read' && written && line.includes('EMERGENCE_CORE6_FILE')) read = true;
      tool = '';
    }
  }
  assert.ok(written && read, 'Successful write and subsequent read evidence required');
  return { guardRecoveries };
}
