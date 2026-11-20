import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../platform/child-environment.ts';

export interface ConfigurationWindow {
  closed: Promise<void>;
  focus(): Promise<boolean>;
  close(): Promise<void>;
}

/** Owns startup, reuse and shutdown as one lifecycle, including a close during native startup. */
export class ConfigurationWindowManager {
  private window?: ConfigurationWindow;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  constructor(private readonly create: () => Promise<ConfigurationWindow>) {}
  open(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('配置服务已关闭，请从涌现重新打开'));
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (this.window && (await this.window.focus())) return;
      if (this.stopped) return;
      this.window = await this.create();
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  async wait() {
    await this.opening;
    await this.window?.closed;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      await this.opening?.catch(() => {}); // A failed startup has no window to close.
      await this.window?.close();
    })();
    return this.closing;
  }
}

/** The native WinForms executable receives its session through stdin, never the process command line. */
export async function openConfigurationWindow(url: string) {
  if (process.platform !== 'win32') throw new Error('原生模型配置工具当前支持 Windows');
  const executable = fileURLToPath(new URL('./model-config/涌现模型配置.exe', import.meta.url));
  try {
    await access(executable);
  } catch {
    throw new Error('缺少原生模型配置工具，请运行 npm run build 或使用完整发行包');
  }
  const child = spawn(executable, ['--attach'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
    env: childEnvironment(),
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });
  child.stdin.on('error', () => {
    /* Exit/ready handlers report startup failures. */
  });
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('原生模型配置窗口启动超时'));
    }, 20000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('原生模型配置窗口未能启动，请检查配置及 Windows .NET Framework 4.8'));
    };
    child.once('error', fail);
    child.once('exit', fail);
    const ready = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.includes('"ready":true')) {
        clearTimeout(timer);
        child.off('error', fail);
        child.off('exit', fail);
        child.stdout.off('data', ready);
        child.stdout.resume();
        resolve();
      }
    };
    child.stdout.on('data', ready);
    child.stdin.write(JSON.stringify({ url }) + '\n');
  });
  return {
    closed,
    async focus() {
      if (exited) return false;
      child.stdin.write('{"action":"focus"}\n');
      return true;
    },
    async close() {
      if (exited) return;
      child.stdin.end('{"action":"close"}\n');
      const timer = setTimeout(() => child.kill(), 5000);
      await closed;
      clearTimeout(timer);
    },
  };
}
