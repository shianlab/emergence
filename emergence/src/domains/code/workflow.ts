import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { digest, inside } from '../../app/instruction-files.ts';
import { safeError } from '../../core/adapters/redaction.ts';
import { fileFingerprint } from '../../core/application/execution-evidence.ts';
import { toolArguments, toolOutcome } from '../../core/domain/tool-contract.ts';
import { readJsonFile, replaceJsonFile } from '../../core/storage/safe-json-file.ts';
import { diagnostics, discoverChecks, isCriterion, matchCheck } from './checks.ts';
import { readSource, scanProject, type ProjectSnapshot } from './project.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const checkSchema = z.object({
  callId: z.string(),
  id: z.string(),
  command: z.string(),
  invocation: z.object({ command: z.string(), cwd: z.string() }).optional(),
  configHash: hash,
  phase: z.enum(['baseline', 'after']),
  version: hash,
  criteria: hash,
  stable: z.boolean(),
  inputs: z.array(z.object({ path: z.string(), hash })).max(256),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'pending']),
  exitCode: z.number().nullable(),
  output: z.string().max(6000),
  diagnostics: z
    .array(
      z.object({ path: z.string(), line: z.number(), column: z.number().nullable(), message: z.string() }),
    )
    .max(40),
});
const changeSchema = z.object({
  path: z.string(),
  before: z.string().max(262144).nullable(),
  beforeHash: z.string(),
  afterHash: z.string(),
  uncertain: z.boolean(),
});
const runSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  root: z.string(),
  session: z.string(),
  objective: z.string().max(500),
  createdAt: z.string(),
  changes: z.array(changeSchema).max(12),
  checks: z.array(checkSchema).max(64),
  initialCriteria: hash,
  incomplete: z.boolean(),
  notes: z.array(z.string()).max(16),
});
export type CodeRun = z.infer<typeof runSchema>;
export type CodeCheck = z.infer<typeof checkSchema>;
export const sourceMutation = (name: string, path: string) =>
  ['write', 'edit'].includes(name) && /\.(?:[cm]?[jt]sx?|py|json|toml|ya?ml|sql|ini|cfg)$/i.test(path);
const criteria = (snapshot: ProjectSnapshot) =>
  digest(
    JSON.stringify(
      snapshot.files
        .filter((f) => isCriterion(f.relative))
        .map((f) => [f.relative, f.hash])
        .sort(),
    ),
  );

/** Per-session bounded artifacts. Task lifecycle and acceptance remain owned by KIM's existing ledger. */
export class CodeWorkflow {
  readonly root: string;
  run?: CodeRun;
  private loaded = false;
  private freshChecks = new Set<string>();
  constructor(
    readonly home: string,
    root: string,
    readonly session: string,
    private canRead: (path: string) => boolean = () => true,
  ) {
    // One physical root for paths, check receipts and durable records, including
    // Windows 8.3 aliases. Descendant links still pass the normal containment checks.
    this.root = realpathSync(root);
  }

  private async location(create: boolean) {
    let directory = await realpath(this.home);
    for (const name of ['core', 'code-runs']) {
      directory = join(directory, name);
      if (create)
        await mkdir(directory).catch((e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('代码记录目录不安全');
    }
    return join(directory, digest(this.session + '\0' + this.root) + '.json');
  }
  async load() {
    if (this.loaded) return;
    try {
      const file = await this.location(false);
      const run = runSchema.parse(await readJsonFile(file, 5_000_000, '代码记录无效'));
      if (
        run.root !== this.root ||
        run.session !== this.session ||
        run.changes.some((c) => c.before !== null && digest(c.before) !== c.beforeHash)
      )
        throw new Error('代码记录范围或内容不匹配');
      this.run = run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }
  async save() {
    if (!this.run) return;
    const file = await this.location(true);
    await replaceJsonFile(file, runSchema.parse(this.run), {
      invalidMessage: '代码记录路径不安全',
      maxBytes: 5_000_000,
      budgetMessage: '代码记录超出预算',
    });
  }
  async begin(objective: string) {
    await this.load();
    const snapshot = await this.snapshot(AbortSignal.timeout(10000));
    if (this.run) {
      const file = await this.location(true),
        archive = file + '.' + digest(this.run.id) + '.archive';
      await writeFile(archive, JSON.stringify(this.run), { flag: 'wx', mode: 0o600 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    this.run = {
      schemaVersion: 1,
      id: randomUUID(),
      root: this.root,
      session: this.session,
      objective: objective.slice(0, 500),
      createdAt: new Date().toISOString(),
      initialCriteria: criteria(snapshot),
      changes: [],
      checks: [],
      incomplete: snapshot.truncated,
      notes: [],
    };
    this.freshChecks.clear();
    await this.save();
    return this.run.id;
  }
  private async ensure() {
    await this.load();
    if (!this.run) await this.begin('自动记录本会话的编程修改与检查');
    return this.run!;
  }
  async snapshot(signal: AbortSignal) {
    return scanProject(this.root, signal, undefined, this.canRead);
  }
  private safe(path: string) {
    const absolute = resolve(this.root, path);
    if (!inside(this.root, absolute) || !this.canRead(absolute))
      throw new Error('代码记录路径超出当前项目或读取权限');
    return absolute;
  }
  async beforeEdit(path: string) {
    const absolute = this.safe(path),
      run = await this.ensure();
    const local = relative(this.root, absolute).replaceAll('\\', '/');
    let source: Awaited<ReturnType<typeof readSource>> | undefined;
    try {
      source = await readSource(this.root, local);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Absent files still need a real in-project parent; never follow a linked parent outwards.
      let ancestor = dirname(absolute),
        parent: string;
      for (;;) {
        try {
          parent = await realpath(ancestor);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
            throw error;
          ancestor = dirname(ancestor);
        }
      }
      if (!inside(this.root, parent)) throw new Error('代码路径父目录超出项目');
    }
    let change = run.changes.find((c) => c.path === local);
    const current = source?.hash ?? 'missing';
    if (change && (change.uncertain || change.afterHash !== current))
      throw new Error(
        '变更集版本冲突：重读文件并用 emergence_code_work begin 建立新的修改基线，保留外部修改',
      );
    if (!change) {
      if (run.changes.length >= 12) throw new Error('本次变更集已达 12 个文件，请拆分任务');
      change = {
        path: local,
        before: source?.text ?? null,
        beforeHash: current,
        afterHash: current,
        uncertain: false,
      };
      run.changes.push(change);
    }
    change.uncertain = true;
    await this.save();
    return { change, current };
  }
  async afterEdit(edit: Awaited<ReturnType<CodeWorkflow['beforeEdit']>>, succeeded: boolean) {
    const current = await fileFingerprint(this.safe(edit.change.path));
    edit.change.afterHash = current;
    edit.change.uncertain = (!succeeded && current !== edit.current) || current.startsWith('unknown:');
    await this.save();
  }
  async beforeCheck(command: string, signal: AbortSignal, workdir = this.root) {
    signal.throwIfAborted();
    const cwd = await realpath(resolve(this.root, workdir));
    const snapshot = await this.snapshot(signal),
      directory = relative(this.root, cwd).replaceAll('\\', '/') || '.',
      candidate = matchCheck(command, discoverChecks(snapshot), directory);
    if (!candidate) return;
    const run = await this.ensure();
    if (run.checks.length >= 64) throw new Error('检查记录已达预算，请总结失败并拆分任务');
    const repeated = run.checks.filter(
      (c) => c.id === candidate.id && c.version === snapshot.version && c.status === 'failed',
    );
    if (repeated.length >= 2)
      throw new Error('相同源码版本的同一检查已失败两次；先分析诊断并调整实现，不再重复空跑');
    run.incomplete ||= snapshot.truncated;
    return {
      snapshot,
      candidate,
      invocation: { command, cwd },
      phase: run.changes.some((c) => c.beforeHash !== c.afterHash || c.uncertain)
        ? ('after' as const)
        : ('baseline' as const),
    };
  }
  async afterCheck(
    input: NonNullable<Awaited<ReturnType<CodeWorkflow['beforeCheck']>>>,
    callId: string,
    name: string,
    value: unknown,
    isError: boolean,
    aborted: boolean,
    output: string,
  ) {
    const run = this.run!,
      args = toolArguments(value);
    // Fresh, independently bounded inspection: cancellation of the command must still leave its failed receipt.
    let final: ProjectSnapshot | undefined;
    try {
      final = await this.snapshot(AbortSignal.timeout(8000));
    } catch {
      run.incomplete = true;
    }
    const record: CodeCheck = {
      callId,
      id: input.candidate.id,
      command: input.candidate.command,
      invocation: input.invocation,
      configHash: input.candidate.configHash,
      phase: input.phase,
      version: input.snapshot.version,
      criteria: criteria(input.snapshot),
      stable:
        !!final && final.version === input.snapshot.version && !final.truncated && !input.snapshot.truncated,
      status: toolOutcome(
        name,
        value,
        isError ||
          /Warning: node:test run\(\) is being called recursively|(?:^|\n)(?:#|ℹ) tests 0\b|no tests (?:ran|collected)/i.test(
            output,
          ),
        aborted,
      ),
      exitCode: typeof args.exitCode === 'number' ? args.exitCode : null,
      inputs: input.snapshot.files.map((f) => ({ path: f.relative, hash: f.hash })),
      output: safeError(output).slice(-6000),
      diagnostics: diagnostics(safeError(output)),
    };
    run.checks.push(record);
    this.freshChecks.add(callId);
    await this.save();
    return record;
  }
  async status(signal: AbortSignal) {
    await this.load();
    const snapshot = await this.snapshot(signal),
      candidates = discoverChecks(snapshot),
      run = this.run;
    const checks = candidates.map((candidate) => {
      const latest = run?.checks.findLast((c) => c.id === candidate.id);
      const baseline = run?.checks.find((c) => c.id === candidate.id && c.phase === 'baseline');
      const accessible = !latest || latest.inputs.every((f) => this.canRead(resolve(this.root, f.path)));
      const passed =
        !!latest &&
        accessible &&
        this.freshChecks.has(latest.callId) &&
        latest.status === 'succeeded' &&
        latest.exitCode === 0 &&
        !run!.checks.some(
          (c) => c.id === candidate.id && c.version === latest.version && c.status === 'failed',
        ) &&
        latest.stable &&
        latest.version === snapshot.version &&
        latest.configHash === candidate.configHash;
      return {
        ...candidate,
        state: passed ? 'passed' : latest ? 'failed-or-stale' : 'not-run',
        baseline: baseline?.status ?? 'not-run',
        comparable: !!baseline && baseline.criteria === criteria(snapshot),
        latest:
          latest && accessible
            ? {
                ...latest,
                inputs: undefined,
                output: latest.output.slice(-1200),
                diagnostics: latest.diagnostics.slice(0, 5),
              }
            : null,
      };
    });
    const changes = await Promise.all(
      (run?.changes ?? []).map(async (c) => {
        // Never disclose denied paths, beforeimages or diagnostics after a permission change.
        if (!this.canRead(resolve(this.root, c.path)))
          return { path: '[读取受限]', beforeHash: '', afterHash: '', current: false, uncertain: true };
        return {
          path: c.path,
          beforeHash: c.beforeHash,
          afterHash: c.afterHash,
          current: (await fileFingerprint(this.safe(c.path))) === c.afterHash,
          uncertain: c.uncertain,
        };
      }),
    );
    const criteriaChanged = !!run && run.initialCriteria !== criteria(snapshot);
    const verified =
      !!checks.length &&
      !criteriaChanged &&
      checks.every((c) => c.state === 'passed') &&
      changes.every((c) => c.current && !c.uncertain) &&
      !snapshot.truncated;
    return {
      schemaVersion: 1,
      runId: run?.id ?? null,
      root: this.root,
      verified,
      criteriaChanged,
      coverage: '有界项目源码快照；不代表未扫描依赖或外部服务',
      truncated: snapshot.truncated,
      changes,
      checks,
      warnings: snapshot.warnings,
      next: criteriaChanged
        ? '测试或配置口径已变化，需要独立审查；不自动以新标准覆盖旧基线。'
        : verified
          ? '当前候选检查已有成功回执；按任务要求进行独立审查与必要回归。'
          : !checks.length
            ? '未发现可识别的检查命令；请明确项目的测试方式，不能把缺少检查视为通过。'
            : '使用普通 Shell 工具运行列出的检查；先读文件再修改，修复后重新检查。未运行/取消/过期均不算通过。',
    };
  }
  async resolvedFailures(signal: AbortSignal) {
    if (!this.run?.checks.some((c) => c.status === 'failed')) return new Set<string>();
    const status = await this.status(signal),
      resolved = new Set<string>();
    for (const check of status.checks)
      if (check.state === 'passed' && check.comparable) {
        for (const earlier of this.run!.checks)
          if (
            earlier.id === check.id &&
            earlier.status === 'failed' &&
            earlier.exitCode !== null &&
            this.freshChecks.has(earlier.callId) &&
            earlier.version !== check.latest!.version &&
            status.changes.some(
              (change) => change.current && !change.uncertain && change.beforeHash !== change.afterHash,
            ) &&
            earlier.criteria === check.latest!.criteria
          )
            resolved.add(earlier.callId);
      }
    return resolved;
  }
  async preview(path: string) {
    await this.load();
    const absolute = this.safe(path),
      local = relative(this.root, absolute).replaceAll('\\', '/');
    const change = this.run?.changes.find((c) => c.path === local);
    if (!change) throw new Error('此文件没有本次变更记录');
    const current = await readSource(this.root, local);
    const oldLines = (change.before ?? '').split('\n'),
      newLines = current.text.split('\n');
    let start = 0,
      oldEnd = oldLines.length,
      newEnd = newLines.length;
    while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return {
      path: local,
      expectedHash: change.afterHash,
      currentHash: current.hash,
      restorable: change.before !== null && current.hash === change.afterHash && !change.uncertain,
      before: change.before?.slice(0, 2000) ?? null,
      after: current.text.slice(0, 2000),
      diff: {
        fromLine: start + 1,
        removedLines: oldEnd - start,
        addedLines: newEnd - start,
        removed: oldLines.slice(start, oldEnd).join('\n').slice(0, 1000),
        added: newLines.slice(start, newEnd).join('\n').slice(0, 1000),
      },
      truncated: (change.before?.length ?? 0) > 2000 || current.text.length > 2000,
      note: '只恢复此会话记录的既有文本文件；新增文件和任意 Shell 副作用不自动删除或撤销。',
    };
  }
  async restoreContent(path: string, expectedHash: string) {
    const preview = await this.preview(path);
    if (!preview.restorable || preview.expectedHash !== expectedHash)
      throw new Error('恢复预览已过期或文件不可恢复；保留当前文件');
    return this.run!.changes.find((c) => c.path === preview.path)!.before!;
  }
}
