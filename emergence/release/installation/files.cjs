const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return (
    relative !== '' &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function noLinks(root, recursive = true) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`Managed path is a link: ${root}`);
  if (recursive && stat.isDirectory())
    for (const entry of await fs.readdir(root)) await noLinks(path.join(root, entry));
}
async function ancestors(root) {
  for (let p = root; ; p = path.dirname(p)) {
    if (await exists(p)) await noLinks(p, false);
    if (path.dirname(p) === p) break;
  }
}
async function hash(p) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(p)) digest.update(chunk);
  return digest.digest('hex');
}
async function json(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}
async function atomic(p, value) {
  await ancestors(p);
  const temporary = `${p}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, p);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function validateFiles(root, files, legacy = false) {
  if (!Array.isArray(files) || files.length < 5 || files.length > 100000)
    throw new Error('Invalid release file list');
  for (const required of [
    'release.json',
    'runtime/node.exe',
    'app/bin/emergence.cjs',
    'manage.cjs',
    ...(!legacy ? ['health.cjs'] : []),
    'app/dist/cli.mjs',
    'app/dist/plugin.mjs',
    'app/dist/data/manifest.json',
    'app/dist/data/worker.py',
    'app/dist/data/analytics.py',
    'app/dist/data/runtime-lock.json',
    'app/dist/data/probe.py',
    '涌现模型配置.exe',
  ])
    if (!files.some((f) => f?.path === required)) throw new Error('Incomplete release manifest');
  const seen = new Set();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.path.includes('\\') ||
      file.path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[. ]$|[<>:"|?*\x00-\x1f]/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
      !inside(root, path.resolve(root, file.path)) ||
      seen.has(file.path.toLowerCase())
    )
      throw new Error('Release path, size or hash is invalid');
    seen.add(file.path.toLowerCase());
  }
}
async function eachFile(files, visit) {
  let index = 0;
  let failure;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (!failure && index < files.length) {
        try {
          await visit(files[index++]);
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure) throw failure; // All in-flight IO has settled before cleanup.
}
async function verify(root, files, legacy = false) {
  validateFiles(root, files, legacy);
  await eachFile(files, async (file) => {
    const full = path.join(root, file.path);
    if ((await fs.stat(full)).size !== file.bytes || (await hash(full)) !== file.sha256)
      throw new Error('Release integrity check failed: ' + file.path);
  });
}
async function copyRelease(source, stage, files) {
  validateFiles(stage, files);
  const directories = new Map();
  await eachFile(files, async (file) => {
    const target = path.join(stage, file.path),
      parent = path.dirname(target);
    if (!directories.has(parent)) directories.set(parent, fs.mkdir(parent, { recursive: true }));
    await directories.get(parent);
    await fs.copyFile(path.join(source, file.path), target, constants.COPYFILE_EXCL);
  });
  await fs.copyFile(
    path.join(source, 'manifest.sha256.json'),
    path.join(stage, 'manifest.sha256.json'),
    constants.COPYFILE_EXCL,
  );
}

function pointer(value) {
  if (
    !value ||
    value.product !== 'emergence' ||
    !versionPattern.test(value.version) ||
    !versionPattern.test(value.directory ?? value.version) ||
    (value.manager !== undefined && !versionPattern.test(value.manager))
  )
    throw new Error('安装版本记录无效');
  return value;
}
function versionPath(root, value) {
  return path.join(root, 'versions', pointer(value).directory ?? value.version);
}
function compareVersions(left, right) {
  if (!versionPattern.test(left) || !versionPattern.test(right)) throw new Error('Invalid version');
  const parts = (value) => {
    const index = value.indexOf('-');
    return index < 0 ? [value, null] : [value.slice(0, index), value.slice(index + 1)];
  };
  const [a, ap] = parts(left),
    [b, bp] = parts(right);
  const ac = a.split('.').map(BigInt),
    bc = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return ac[i] < bc[i] ? -1 : 1;
  if (ap === bp) return 0;
  if (ap === null) return 1;
  if (bp === null) return -1;
  const aa = ap.split('.'),
    bb = bp.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]),
      bn = /^\d+$/.test(bb[i]);
    if (an && bn) {
      if (BigInt(aa[i]) === BigInt(bb[i])) continue;
      return BigInt(aa[i]) < BigInt(bb[i]) ? -1 : 1;
    }
    if (an !== bn) return an ? -1 : 1;
    return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}
async function removeOwned(root, target) {
  await ancestors(root);
  await ancestors(target);
  const canonicalRoot = await fs.realpath(root),
    canonicalTarget = await fs.realpath(target);
  if (
    !inside(canonicalRoot, canonicalTarget) ||
    path.resolve(target).toLowerCase() !== canonicalTarget.toLowerCase()
  )
    throw new Error('拒绝清理不属于安装目录的路径');
  await noLinks(target);
  await fs.rm(target, { recursive: true });
}
module.exports = {
  versionPattern,
  inside,
  exists,
  noLinks,
  ancestors,
  hash,
  json,
  atomic,
  validateFiles,
  verify,
  copyRelease,
  pointer,
  versionPath,
  removeOwned,
  compareVersions,
};
