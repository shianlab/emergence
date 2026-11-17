const path = require('node:path');
const F = require('./files.cjs');

// Observational only: diagnostics must never change transaction success or expose user data.
function createDiagnostics(root, action) {
  const timings = [];
  async function measure(phase, run) {
    const started = Date.now();
    console.log('涌现安装：' + phase + '…');
    try {
      const result = await run();
      timings.push({ phase, milliseconds: Date.now() - started });
      console.log(phase + '完成（' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒）');
      return result;
    } catch (error) {
      timings.push({ phase, milliseconds: Date.now() - started, failed: true });
      throw error;
    }
  }
  async function finish(ok, version) {
    try {
      await F.atomic(path.join(root, 'install-diagnostics.json'), { action, ok, version, timings });
    } catch {
      console.error('无法保存安装诊断记录；本次安装结果不受影响。');
    }
  }
  return { measure, finish };
}
module.exports = { createDiagnostics };
