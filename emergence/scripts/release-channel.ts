import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { compareVersions, manifestSchema } from '../src/app/updates/manifest.ts';

// Produces local, immutable publication inputs only. Upload and stable-pointer changes are separate.
const record = JSON.parse(await readFile('../artifacts/phase6/release-path.json', 'utf8'));
if (compareVersions(record.version, '1.0.2') < 0)
  throw Error('稳定更新通道不得覆盖已发布的 1.0.1；请先确定新版本并重新打包');
if (!record.archive || !record.sha256 || !process.argv[2] || !/^\d+$/.test(process.argv[3] ?? ''))
  throw Error('先打包 ZIP，再执行 release-channel.ts <更新说明.md> <递增发行序号>');
for (const [file, expected] of Object.entries(record.inputHashes)) {
  if (
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex') !== expected
  )
    throw Error('发行输入在打包后发生改变：' + file);
}
const digest = createHash('sha256');
for await (const chunk of createReadStream(record.archive)) digest.update(chunk);
if (digest.digest('hex') !== record.sha256) throw Error('发行包哈希不符');
const value = manifestSchema.parse({
  schema: 1,
  product: 'emergence',
  platform: 'win32-x64',
  version: record.version,
  sequence: Number(process.argv[3]),
  minimumInstaller: 2,
  publishedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
  asset: {
    url: `https://github.com/shianlab/emergence/releases/download/v${record.version}/Emergence-${record.version}-win32-x64.zip`,
    bytes: (await stat(record.archive)).size,
    sha256: record.sha256,
  },
  notes: await readFile(process.argv[2], 'utf8'),
  notesURL: `https://github.com/shianlab/emergence/releases/tag/v${record.version}`,
});
const directory = resolve('../artifacts/releases/channel-' + record.version + '-' + value.sequence);
await mkdir(directory, { recursive: true });
const input = join(directory, 'manifest.json');
await writeFile(input, JSON.stringify(value, null, 2), { flag: 'wx' });
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'scripts/release-signing.ts', 'sign', input, join(directory, 'update.json')],
  { stdio: 'inherit', windowsHide: true },
);
const code = await new Promise<number | null>((done, reject) => {
  child.once('error', reject);
  child.once('close', done);
});
if (code !== 0) throw Error('发行清单签名失败');
await writeFile(join(directory, 'stable.json'), await readFile(join(directory, 'update.json')), {
  flag: 'wx',
});
console.log('已准备签名清单；先发布不可变资产并匿名验证，最后发布 stable.json。');
