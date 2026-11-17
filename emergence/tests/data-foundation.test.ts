import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeData, dataRuntime, runWorker } from '../src/domains/data/service.ts';
import { executionFixture } from './fixtures/core-execution.ts';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'emergence-data-')),
    root = join(home, '中文数据');
  await mkdir(root);
  await writeFile(
    join(root, '样本.csv'),
    'ID,金额,日期\r\n001,12.50,2026-10-31\r\n002,,坏日期\r\n9007199254740993,7.50,2026-11-01\r\n001,12.50,2026-10-31\r\n',
  );
  return { home, root };
}
const signal = () => AbortSignal.timeout(30000);
test('CSV full profile preserves ID and long integer; SQL computes actual totals without changing source', async () => {
  const f = await fixture(),
    path = join(f.root, '样本.csv'),
    before = await readFile(path);
  const profile = await analyzeData(f.root, f.home, { file_path: '样本.csv' }, signal());
  assert.equal(profile.rows, 4);
  assert.equal(profile.duplicateRows, 1);
  assert.equal(profile.columns[1].missing, 1);
  assert.equal(profile.sample[2][0], '9007199254740993');
  const query = await analyzeData(
    f.root,
    f.home,
    { file_path: '样本.csv', sql: 'SELECT sum(CAST("金额" AS DECIMAL(20,2))) AS total FROM data' },
    signal(),
  );
  assert.deepEqual(query.query.rows, [['32.50']]);
  assert.deepEqual(await readFile(path), before);
  assert.equal(JSON.parse(await readFile(join(query.artifact, 'manifest.json'), 'utf8')).status, 'succeeded');
});
test('real XLSX multiple sheets, absent formula cache and exact Parquet integers', async () => {
  const f = await fixture(),
    runtime = await dataRuntime();
  execFileSync(runtime.python, [
    '-I',
    '-c',
    `from openpyxl import Workbook\nimport duckdb,sys,pathlib\np=pathlib.Path(sys.argv[1]); w=Workbook();s=w.active;s.title='数据';s.append(['ID','计算']);s.append(['001','=1+1']);w.create_sheet('其他');w.save(p/'book.xlsx');c=duckdb.connect();c.execute("COPY (SELECT 9007199254740993::BIGINT AS id) TO '"+str(p/'table.parquet').replace("'","''")+"' (FORMAT PARQUET)")`,
    f.root,
  ]);
  assert.equal((await analyzeData(f.root, f.home, { file_path: 'book.xlsx' }, signal())).selectSheet, true);
  const sheet = await analyzeData(f.root, f.home, { file_path: 'book.xlsx', sheet: '数据' }, signal());
  assert.equal(sheet.missingFormulaCaches, 1);
  await assert.rejects(
    analyzeData(
      f.root,
      f.home,
      { file_path: 'book.xlsx', sheet: '数据', sql: 'SELECT * FROM data' },
      signal(),
    ),
    /缓存/,
  );
  const parquet = await analyzeData(f.root, f.home, { file_path: 'table.parquet' }, signal());
  assert.equal(parquet.sample[0][0], '9007199254740993');
});
test('bad rows, empty inputs, encoding ambiguity, source scope and unsafe SQL fail closed', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'bad.csv'), 'a,b\n1,2,3');
  await writeFile(join(f.root, 'empty.csv'), '');
  for (const path of ['bad.csv', 'empty.csv'])
    await assert.rejects(analyzeData(f.root, f.home, { file_path: path }, signal()));
  await writeFile(join(f.root, 'gb.csv'), Buffer.from([0x49, 0x44, 10, 0xd6, 0xd0, 0xce, 0xc4]));
  await assert.rejects(analyzeData(f.root, f.home, { file_path: 'gb.csv' }, signal()), /编码/);
  assert.equal(
    (await analyzeData(f.root, f.home, { file_path: 'gb.csv', encoding: 'gb18030' }, signal())).sample[0][0],
    '中文',
  );
  for (const sql of [
    'DELETE FROM data',
    'SELECT 1; SELECT 2',
    "COPY data TO 'stolen.csv'",
    "SELECT * FROM read_csv('request.json')",
    "SELECT * FROM read_parquet('https://example.com/data.parquet')",
  ]) {
    await assert.rejects(analyzeData(f.root, f.home, { file_path: '样本.csv', sql }, signal()));
  }
  await writeFile(join(f.home, 'outside.csv'), 'id\n1');
  await assert.rejects(analyzeData(f.root, f.home, { file_path: '../outside.csv' }, signal()), /项目内/);
  await assert.rejects(
    analyzeData(f.root, f.home, { file_path: '样本.csv' }, signal(), () => false),
    /权限/,
  );
});
test('timeouts and cancellation terminate the Windows worker process tree; missing interpreter is explicit', async () => {
  const f = await fixture(),
    runtime = await dataRuntime(),
    worker = join(f.home, 'tree.py'),
    pidfile = join(f.home, 'pid.txt');
  await writeFile(
    worker,
    "import subprocess,sys,time,pathlib\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\npathlib.Path('pid.txt').write_text(str(p.pid))\ntime.sleep(60)\n",
  );
  await assert.rejects(runWorker(runtime.python, worker, {}, f.home, signal(), 1500), /超时/);
  const pid = Number(await readFile(pidfile, 'utf8'));
  assert.throws(() => process.kill(pid, 0));
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 1200);
  await assert.rejects(runWorker(runtime.python, worker, {}, f.home, cancel.signal, 10000), /取消/);
  assert.throws(() =>
    process.kill(
      Number(execFileSync(runtime.python, ['-c', `print(open(r'${pidfile}').read())`], { encoding: 'utf8' })),
      0,
    ),
  );
  await assert.rejects(runWorker(join(f.home, 'missing.exe'), worker, {}, f.home, signal()), /环境不可用/);
});
test('real Harness exposes native data profile in Plan mode with genuine source receipt', async () => {
  const f = await executionFixture();
  try {
    await writeFile(join(f.cwd, 'data.csv'), 'id,value\n001,3\n');
    let step = 0;
    f.provider.stream = async function* (): AsyncIterable<StreamChunk> {
      if (step++) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const id = ToolCallId('native-data'),
        name = 'emergence_data_profile',
        raw = JSON.stringify({ file_path: 'data.csv' });
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    const c = f.w.current.controller!;
    c.setPermissionMode('plan');
    await f.w.send(f.w.focused, '查看数据的行数');
    await c.agent.whenIdle();
    const results = c.agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
    assert.ok(
      results.some(
        (e) =>
          e.type === 'tool/result' &&
          !e.data.message.isError &&
          JSON.stringify(e.data.message).includes('001'),
      ),
    );
  } finally {
    await f.close();
  }
});

test('bounded full scan rejects oversized rows and changed permission instead of returning partial success', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'large.csv'), 'id\n' + '1\n'.repeat(10001));
  await assert.rejects(analyzeData(f.root, f.home, { file_path: 'large.csv' }, signal()), /预算/);
  await writeFile(join(f.root, 'cell.csv'), 'id\n' + 'x'.repeat(4001));
  await assert.rejects(analyzeData(f.root, f.home, { file_path: 'cell.csv' }, signal()), /字符/);
  let checks = 0;
  await assert.rejects(
    analyzeData(f.root, f.home, { file_path: '样本.csv' }, signal(), () => ++checks < 2),
    /失效/,
  );
});
