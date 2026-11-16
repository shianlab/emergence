import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticFileSchema, type RunDiagnostic } from '../domain/run-diagnostics.ts';
import { digest } from './execution-journal.ts';
import { readJsonFile, replaceJsonFile } from './safe-json-file.ts';

/** Additive, bounded v1 diagnostics. Never a source of execution/retry authority. */
export class RunDiagnosticsStore {
  constructor(private home: string) {}
  private async path(session: string) {
    let path = await realpath(this.home);
    for (const part of ['core', 'run-diagnostics']) {
      path = join(path, part);
      await mkdir(path).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('阶段计时目录不安全');
    }
    return join(path, digest(session) + '.json');
  }
  async read(session: string) {
    try {
      const file = diagnosticFileSchema.parse(
        await readJsonFile(await this.path(session), 128000, '阶段计时文件无效'),
      );
      if (file.session !== session || file.runs.some((run) => run.session !== session))
        throw new Error('阶段计时归属不符');
      return file.runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async write(session: string, runs: RunDiagnostic[]) {
    const value = diagnosticFileSchema.parse({ version: 1, session, runs });
    await replaceJsonFile(await this.path(session), value, {
      maxBytes: 128000,
      invalidMessage: '阶段计时文件无效',
    });
  }
}
