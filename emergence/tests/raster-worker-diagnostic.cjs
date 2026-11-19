const { spawn } = require('node:child_process');
const { join, dirname, resolve } = require('node:path');
const exe = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const script = resolve('src/app/tui/small-text.ps1');
const label = { id: 'fixture', text: 'Fixture text', width: 800, height: 20, fontPixels: 14, foreground: '#a3a3a3', background: '#111111' };
const input = JSON.stringify({ labels: [label] }) + '\n';
const isolated = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
async function probe(name, env, end) {
  const begun = Date.now();
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: dirname(script), env, windowsHide: true, stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (part) => {
    stdout += part;
    if (stdout.includes('\n')) child.kill();
  });
  child.stderr.on('data', (part) => { stderr += part; });
  child.stdin.on('error', () => {});
  if (end) child.stdin.end(input);
  else child.stdin.write(input);
  const timer = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise((done) => {
    child.once('error', (error) => { stderr += error.message; done(null); });
    child.once('close', done);
  });
  clearTimeout(timer);
  return { name, code, elapsed: Date.now() - begun, png: stdout.includes('"png"'), stdoutBytes: stdout.length, stderr: stderr.slice(0, 1300) };
}
const extended = { ...isolated, WINDIR: process.env.WINDIR, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramFiles: process.env.ProgramFiles, PATH: join(process.env.SystemRoot, 'System32') };
const names = ['APPDATA','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','ComSpec','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','OS','PATHEXT','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PSModulePath','SystemDrive','TEMP','TMP','USERDOMAIN','USERNAME','USERPROFILE','WINDIR'];
const filtered = Object.fromEntries(names.map(name=>[name,process.env[name]]).filter(([,value])=>value !== undefined));
filtered.SystemRoot=process.env.SystemRoot;
filtered.Path=[join(filtered.SystemRoot,'System32'),filtered.SystemRoot,join(filtered.SystemRoot,'System32/WindowsPowerShell/v1.0')].join(';');
Promise.all([
  probe('windows-allowlist', filtered, false),
  probe('allowlist-with-inherited-path', {...filtered,Path:process.env.Path}, false),
  probe('path-only-plus-modules', {...isolated,Path:process.env.Path,PSModulePath:process.env.PSModulePath}, false),
  probe('profile-plus-windows-module-path', {...extended,PSModulePath:process.env.PSModulePath}, false),
  probe('full-environment', process.env, false),
]).then((results) => console.log(JSON.stringify(results)));
