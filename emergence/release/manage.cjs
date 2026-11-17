// All maintenance actions share the same installation transaction service.
const { createInstaller } = require('./installation/service.cjs');
const files = require('./installation/files.cjs');
const windows = require('./installation/windows.cjs');
module.exports = {
  ...files,
  updatePath: windows.updatePath,
  powershell: windows.powershell,
  createInstaller,
};
if (require.main === module) {
  const [action, root, source, ...flags] = process.argv.slice(2);
  if (!root || flags.some((flag) => flag !== '--no-path')) throw new Error('Invalid installation invocation');
  createInstaller()
    .run({ action, root, source, noPath: flags.includes('--no-path') })
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.changed) console.log('涌现版本已验证并启用；正在运行的窗口保持原版本，下次启动生效。');
    })
    .catch((error) => {
      console.error('涌现安装：' + error.message);
      process.exitCode = 1;
    });
}
