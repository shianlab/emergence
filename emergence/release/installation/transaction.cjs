const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./files.cjs');

const bridges = {
  'launch-support.ps1': 'launch-support.ps1',
  'run-manager.ps1': 'run-manager.ps1',
  'maintenance.ps1': 'maintenance.ps1',
  'uninstall.ps1': 'uninstall.ps1',
  'bin/emergence.cmd': 'emergence.cmd',
  'bin/emergence.ps1': 'emergence.ps1',
};
const names = [...Object.keys(bridges), 'current.previous.json', 'current.json', 'installation.json'];
const serialize = (value) => JSON.stringify(value, null, 2);
async function text(root, name) {
  const file = path.join(root, name);
  await F.ancestors(file);
  return (await F.exists(file)) ? fs.readFile(file, 'utf8') : null;
}
async function snapshot(root) {
  const values = {};
  for (const name of names) values[name] = await text(root, name);
  return values;
}
function validate(journal) {
  if (
    journal?.schema !== 1 ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    !['preparing', 'prepared', 'activating', 'activated', 'committed'].includes(journal.state) ||
    !journal.before ||
    !journal.after
  )
    throw new Error('安装事务记录无效；请保留记录并重新运行完整发行包的安装器');
  for (const map of [journal.before, journal.after])
    for (const [name, value] of Object.entries(map))
      if (!names.includes(name) || (value !== null && (typeof value !== 'string' || value.length > 200000)))
        throw new Error('安装恢复路径或内容无效');
  if (names.some((name) => !(name in journal.before))) throw new Error('安装事务快照不完整');
  if (journal.candidate && !F.versionPattern.test(journal.candidate)) throw new Error('安装候选路径无效');
  if (journal.engine && !F.versionPattern.test(journal.engine)) throw new Error('安装管理器路径无效');
  if (journal.after['current.json']) F.pointer(JSON.parse(journal.after['current.json']));
  return journal;
}
async function save(root, journal) {
  validate(journal);
  await F.atomic(path.join(root, 'install-transaction.json'), journal);
}
async function load(root) {
  const file = path.join(root, 'install-transaction.json');
  await F.ancestors(file);
  return (await F.exists(file)) ? validate(await F.json(file)) : null;
}
async function restore(root, journal) {
  // Restore activation first; entry scripts can then be restored without exposing a new payload.
  for (const name of ['current.json', ...names.filter((name) => name !== 'current.json')]) {
    const current = await text(root, name),
      before = journal.before[name];
    if (current === before) continue;
    if (current !== journal.after[name] && current !== null)
      throw new Error('安装期间入口被外部修改，已保留：' + name);
    const target = path.join(root, name);
    if (before === null) await fs.rm(target, { force: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await F.atomic(target, before);
    }
  }
}
async function planEntries(root, engine, owner, before) {
  const after = {};
  for (const [target, source] of Object.entries(bridges)) {
    const old = before[target];
    let expected = owner.entryHashes?.[target];
    if (!expected && old !== null && before['current.json']) {
      const prior = F.pointer(JSON.parse(before['current.json']));
      const priorFile = path.join(F.versionPath(root, prior), source);
      if (await F.exists(priorFile)) expected = await F.hash(priorFile);
    }
    if (old !== null && (!expected || crypto.createHash('sha256').update(old).digest('hex') !== expected))
      throw new Error(
        '检测到自定义或修改过的启动入口，未覆盖：' + target + '。请先保留自定义脚本，再使用官方入口安装。',
      );
    after[target] = await fs.readFile(path.join(engine, source), 'utf8');
  }
  const entryHashes = Object.fromEntries(
    Object.entries(after).map(([name, value]) => [
      name,
      crypto.createHash('sha256').update(value).digest('hex'),
    ]),
  );
  after['installation.json'] = serialize({ ...owner, schema: 2, entryHashes });
  return after;
}
module.exports = { bridges, names, serialize, snapshot, save, load, restore, planEntries };
