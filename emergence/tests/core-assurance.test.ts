import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileObservation } from '../src/core/application/execution-evidence.ts';
import { executionFixture } from './fixtures/core-execution.ts';

test('native text counts distinguish bytes, Unicode code points and Han characters without treating invalid UTF8 as empty', async () => {
  const f = await executionFixture();
  try {
    const file = join(f.cwd, 'counts.txt');
    await writeFile(file, '涌现A😀\n');
    const value = await fileObservation(file, true);
    assert.equal(value.characters, 5);
    assert.equal(value.hanCharacters, 2);
    assert.equal(value.fileSize, 12);
    await writeFile(file, Buffer.from([0xff]));
    const invalid = await fileObservation(file, true);
    assert.equal(invalid.utf8Valid, false);
    assert.equal(invalid.characters, undefined);
  } finally {
    await f.close();
  }
});

test('native file observations distinguish final LF, CRLF, BOM and no newline without shell execution', async () => {
  const f = await executionFixture();
  try {
    const path = join(f.cwd, 'bytes.txt');
    await writeFile(path, '\uFEFF中\r\n');
    const crlf = await fileObservation(path);
    assert.equal(crlf.fileSize, 8);
    assert.equal(crlf.utf8Bom, true);
    assert.equal(crlf.trailingNewline, 'CRLF');
    await writeFile(path, '中\n');
    const lf = await fileObservation(path);
    assert.equal(lf.fileSize, 4);
    assert.equal(lf.trailingNewline, 'LF');
    assert.equal(lf.utf8Bom, false);
    assert.notEqual(lf.hash, crlf.hash);
    await writeFile(path, '中');
    assert.equal((await fileObservation(path)).trailingNewline, 'none');
  } finally {
    await f.close();
  }
});
