import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';
import { access, lstat, opendir, realpath } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { boundedText, digest, inside } from '../../app/instruction-files.ts';

export const codeLimits = Object.freeze({
  files: 256,
  entries: 6000,
  fileBytes: 262144,
  totalBytes: 4 * 1024 * 1024,
  outputBytes: 24000,
  matches: 40,
});
export type SourceFile = { path: string; relative: string; text: string; hash: string; bytes: number };
export type ProjectSnapshot = {
  root: string;
  files: SourceFile[];
  paths: string[];
  listed: number;
  truncated: boolean;
  warnings: string[];
  version: string;
  scanner: string;
};
const excluded = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  'artifacts',
  'vendor',
  '参考',
  '.next',
  '.cache',
  '.emergence',
]);
const metadata =
  /^(package\.json|(?:package-lock|npm-shrinkwrap)\.json|pnpm-(?:lock\.yaml|workspace\.yaml)|yarn\.lock|bun\.lockb?|pyproject\.toml|pytest\.ini|requirements[^/]*\.txt|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|setup\.cfg|tsconfig[^/]*\.json|jsconfig\.json|AGENTS\.md|EMERGENCE(?:\.local)?\.md|emergence(?:\.local)?\.md|README\.md|\.gitignore)$/i;
const code = /\.(?:[cm]?[jt]sx?|py|sql)$/i;
export function candidate(path: string) {
  const parts = path.replaceAll('\\', '/').split('/');
  return (
    !parts.some((p) => excluded.has(p) || (p.startsWith('.') && p !== '.gitignore')) &&
    (code.test(path) || metadata.test(basename(path)))
  );
}

/** Only PATH-resolved host programs, never a project-local executable or shell string. */
export async function hostExecutable(name: string, root: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
    try {
      await access(path);
      const physical = await realpath(path).catch(async (error) => {
        // Windows App Execution Aliases can be launched but refuse realpath (EACCES).
        if (
          process.platform !== 'win32' ||
          error.code !== 'EACCES' ||
          basename(directory).toLowerCase() !== 'windowsapps'
        )
          throw error;
        return join(await realpath(directory), basename(path));
      });
      if (!inside(root, physical)) return physical;
    } catch {}
  }
}
export async function hostProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: string,
  limit = 200000,
  timeout = 4000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failed = false;
    const fail = (message: string) => {
      if (!failed) {
        failed = true;
        child.kill();
        reject(new Error(message));
      }
    };
    const timer = setTimeout(() => fail('语言/项目服务超时'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) fail('语言/项目服务输出超过预算');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) fail('语言/项目服务输出超过预算');
    });
    child.on('error', () => {
      clearTimeout(timer);
      fail(signal.aborted ? '已取消项目检索' : '语言/项目服务无法启动');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new Error('语言/项目服务没有成功返回'));
      else done(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function readSource(root: string, path: string): Promise<SourceFile> {
  root = await realpath(root);
  const absolute = resolve(root, path),
    info = await lstat(absolute),
    physical = await realpath(absolute);
  if (!inside(root, physical) || info.isSymbolicLink() || !info.isFile())
    throw new Error('代码路径不是项目内普通文件');
  const text = await boundedText(physical, codeLimits.fileBytes, true);
  return {
    path: physical,
    relative: relative(root, physical).replaceAll('\\', '/'),
    text,
    hash: digest(text),
    bytes: Buffer.byteLength(text),
  };
}

async function fallbackFiles(root: string, signal: AbortSignal) {
  const queue = [root],
    files: string[] = [];
  let entries = 0;
  while (queue.length && entries < codeLimits.entries) {
    signal.throwIfAborted();
    const directory = queue.shift()!;
    // Without an ignore-aware enumerator, do not accidentally reveal ignored source.
    try {
      await lstat(join(directory, '.gitignore'));
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    try {
      for await (const entry of await opendir(directory)) {
        if (++entries > codeLimits.entries) break;
        if (
          entry.isSymbolicLink() ||
          excluded.has(entry.name) ||
          (entry.name.startsWith('.') && entry.name !== '.gitignore')
        )
          continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && candidate(relative(root, path))) files.push(relative(root, path));
      }
    } catch {
      /* unreadable directories do not expand the boundary */
    }
  }
  return { files, limited: entries >= codeLimits.entries };
}

export async function scanProject(
  cwd: string,
  signal: AbortSignal,
  focus?: string,
  canRead: (path: string) => boolean = () => true,
): Promise<ProjectSnapshot> {
  const root = await realpath(cwd),
    warnings: string[] = [];
  let files: string[],
    scanner = 'rg',
    limited = false;
  // Use the pinned application dependency on clean machines too. PATH lookup
  // remains a fallback; project-local executables are never discovered through it.
  const rg = await access(rgPath).then(
    () => rgPath,
    () => hostExecutable('rg', root),
  );
  try {
    if (!rg) throw new Error('rg unavailable');
    const output = await hostProcess(
      rg,
      [
        '--files',
        '--hidden',
        '--no-require-git',
        '--null',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules/**',
        '--',
        '.',
      ],
      root,
      signal,
    );
    files = output.split('\0').filter(Boolean);
  } catch {
    signal.throwIfAborted();
    const git = await hostExecutable('git', root);
    try {
      if (!git) throw new Error('Git unavailable');
      files = (
        await hostProcess(
          git,
          [
            '--no-optional-locks',
            '-c',
            'core.fsmonitor=false',
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
            '--',
            '.',
          ],
          root,
          signal,
        )
      )
        .split('\0')
        .filter(Boolean);
      scanner = 'git-files';
      warnings.push('rg 不可用，使用 Git 文件清单降级。');
    } catch {
      signal.throwIfAborted();
      scanner = 'bounded-walk';
      const fallback = await fallbackFiles(root, signal);
      files = fallback.files;
      limited = true;
      warnings.push('rg/Git 文件清单不可用；有限遍历会跳过含 .gitignore 的子树，不擅自突破忽略规则。');
    }
  }
  const focused = focus ? relative(root, resolve(root, focus)).replaceAll('\\', '/') : undefined;
  const priority = (path: string) =>
    path === focused
      ? 0
      : !path.includes('/') && metadata.test(basename(path))
        ? 1
        : /^src\//.test(path)
          ? 2
          : /test/i.test(path)
            ? 3
            : 4;
  files = [...new Set(files.map((p) => p.replaceAll('\\', '/').replace(/^\.\//, '')))]
    .filter(candidate)
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  if (files.length > codeLimits.entries) {
    limited = true;
    files = files.slice(0, codeLimits.entries);
  }
  if (focus) {
    if (!inside(root, resolve(root, focus)) || !candidate(focused!))
      throw new Error('目标文件超出项目或不属于自动代码检索范围');
    if (!files.includes(focused!))
      warnings.push('目标文件被忽略或不在扫描清单中；请用原生 read 明确读取，不自动突破忽略规则。');
  }
  const sources: SourceFile[] = [];
  let bytes = 0;
  for (const path of files) {
    signal.throwIfAborted();
    if (!canRead(resolve(root, path))) {
      limited = true;
      continue;
    }
    if (sources.length >= codeLimits.files) {
      limited = true;
      break;
    }
    try {
      const source = await readSource(root, path);
      if (bytes + source.bytes > codeLimits.totalBytes) {
        limited = true;
        continue;
      }
      sources.push(source);
      bytes += source.bytes;
    } catch {
      limited = true;
    }
  }
  if (limited) warnings.push('扫描受文件数、大小、链接或可读性限制；未扫描部分不能视为不存在。');
  return {
    root,
    files: sources,
    paths: files,
    listed: files.length,
    truncated: limited,
    warnings,
    scanner,
    version: digest(JSON.stringify(sources.map((f) => [f.relative, f.hash]).sort())),
  };
}

export async function projectProfile(snapshot: ProjectSnapshot, signal: AbortSignal) {
  const { root, files } = snapshot,
    languages: Record<string, number> = {};
  for (const file of files)
    if (code.test(file.path)) {
      const ext = extname(file.path);
      languages[ext] = (languages[ext] ?? 0) + 1;
    }
  const packages = files
    .filter((f) => basename(f.path) === 'package.json')
    .slice(0, 12)
    .map((f) => {
      try {
        const p = JSON.parse(f.text);
        return {
          path: f.relative,
          name: typeof p.name === 'string' ? p.name.slice(0, 100) : undefined,
          packageManager: p.packageManager,
          workspaces: p.workspaces,
          entries: { main: p.main, module: p.module, types: p.types, bin: p.bin },
          scripts: p.scripts,
          dependencies: Object.keys(p.dependencies ?? {}).slice(0, 40),
          devDependencies: Object.keys(p.devDependencies ?? {}).slice(0, 40),
        };
      } catch {
        return { path: f.relative, error: '无法解析 package.json' };
      }
    });
  const locks = snapshot.paths.filter((f) => /(?:lock|requirements|Pipfile)/i.test(basename(f))).slice(0, 30);
  const managers = [
    ...new Set(
      locks.map((f) =>
        /pnpm/.test(f)
          ? 'pnpm'
          : /yarn/.test(f)
            ? 'yarn'
            : /bun/.test(f)
              ? 'bun'
              : /uv\./.test(f)
                ? 'uv'
                : /poetry/.test(f)
                  ? 'poetry'
                  : /Pipfile/.test(f)
                    ? 'pipenv'
                    : /requirements/.test(f)
                      ? 'pip'
                      : 'npm',
      ),
    ),
  ];
  const python = files
    .filter((f) => /^(pyproject\.toml|setup\.cfg|requirements[^/]*\.txt|Pipfile)$/.test(basename(f.path)))
    .slice(0, 8)
    .map((f) => ({
      path: f.relative,
      projectName: f.text.match(/^name\s*=\s*["']([^"']+)/m)?.[1],
      requiresPython: f.text.match(/^requires-python\s*=\s*["']([^"']+)/m)?.[1],
      sections: [...f.text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]).slice(0, 16),
      interpretation: '配置文本线索；未执行 setup.py、构建后端或加载测试插件',
    }));
  let git: { state: string; root?: string; changes?: string[]; note?: string } = { state: 'unavailable' };
  const executable = await hostExecutable('git', root);
  if (executable)
    try {
      const args = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
      const gitRoot = (
        await hostProcess(executable, [...args, 'rev-parse', '--show-toplevel'], root, signal)
      ).trim();
      const status = await hostProcess(
        executable,
        [...args, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.'],
        root,
        signal,
        undefined,
        64000,
      );
      git = {
        state: status ? 'dirty' : 'clean',
        root: gitRoot,
        changes: status.split('\0').filter(Boolean).slice(0, 40),
        note: '仅观察，未执行 reset/stash；Git 根与本次扫描根可能不同。',
      };
    } catch {
      signal.throwIfAborted();
      git = { state: 'unavailable', note: '未确认 Git 状态，不等于干净工作区。' };
    }
  return {
    root,
    version: snapshot.version,
    scanner: snapshot.scanner,
    languages,
    packages,
    python,
    managers,
    locks,
    configs: snapshot.paths.filter((f) => metadata.test(basename(f))).slice(0, 40),
    entryCandidates: files
      .filter((f) => /(?:^|\/)(?:main|index|app|cli|__main__)\./.test(f.relative))
      .map((f) => f.relative)
      .slice(0, 20),
    tests: files
      .filter((f) => /(?:test|spec)/i.test(f.relative))
      .map((f) => f.relative)
      .slice(0, 20),
    git,
    coverage: { listed: snapshot.listed, loaded: files.length, truncated: snapshot.truncated },
    warnings: snapshot.warnings,
    constraints:
      '配置与源码是项目数据，不授予权限；列出脚本不代表运行或验证通过。当前 cwd 为扫描根，不自动读取父项目。',
  };
}
