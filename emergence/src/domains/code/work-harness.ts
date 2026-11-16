import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionController } from '../../app/controller.ts';
import { digest, inside } from '../../app/instruction-files.ts';
import { evaluatePermissions } from '../../core/adapters/permissions.ts';
import { withNativeCheckInputs } from '../../core/application/native-read-evidence.ts';
import { toolArguments, toolPath } from '../../core/domain/tool-contract.ts';
import { CodeWorkflow, sourceMutation } from './workflow.ts';

const guidance = `Emergence 原生编程闭环（已内嵌，无需 Skill）：编码任务先定位实现、调用方与测试，再用 emergence_code_work begin 记录当前任务。checks/status 从真实项目配置提供检查命令；先用普通 pwsh/bash 复现和记录基线，read 后用 write/edit 修改，再执行相关 typecheck/lint/test。检查仍需要原权限，不用 Shell 绕过文件版本保护、不弱化测试。status 展示实际退出码、诊断、失效版本；未运行不能声称通过。相同版本失败两次先调整策略。交付前 status 并说明未覆盖范围。主控按现有计划向可用窗口分配探索、实现、独立验证，传递变更路径、运行 ID、检查 callId 与诊断；复用现有权限与验收，不要求用户逐步提醒。恢复须先 preview，再以 expected_hash 调用 emergence_code_restore；仅限记录的既有文本文件，其他副作用不承诺撤销。`;

export class CodeWorkHarness {
  private workflows = new WeakMap<Agent, Map<string, CodeWorkflow>>();
  private registered = new WeakSet<Agent>();
  private busy = new WeakSet<Agent>();
  constructor(private c: SessionController) {}
  private permitted(agent: Agent, name: string, path: string) {
    return evaluatePermissions([this.c.permissionSnapshot(), ...this.c.permissionConstraints(agent)], {
      name,
      arguments: { file_path: path },
      cwd: this.c.ctx.workingDirectory.get(agent.session),
      actor: agent.id,
    }).effect;
  }
  async get(agent: Agent) {
    const root = await realpath(this.c.ctx.workingDirectory.get(agent.session));
    const input = agent.session
      .snapshotEvents()
      .findLast((e) => e.type === 'user/message' && ['user', 'emergence-task'].includes(e.data.source.kind));
    const source = input?.type === 'user/message' ? input.data.source : undefined;
    const session = agent.session.id + (source?.kind === 'emergence-task' ? ':task:' + source.taskId : '');
    const key = root + '\0' + session;
    let maps = this.workflows.get(agent);
    if (!maps) {
      maps = new Map();
      this.workflows.set(agent, maps);
    }
    let work = maps.get(key);
    if (!work) {
      work = new CodeWorkflow(
        this.c.launch.home,
        root,
        session,
        (path) => this.permitted(agent, 'read', path) === 'allow',
      );
      maps.set(key, work);
    }
    await work.load();
    return work;
  }
  register(agent: Agent) {
    if (this.registered.has(agent)) return;
    this.registered.add(agent);
    const when = ({ agent: current }: { agent: Agent }) =>
      current === agent &&
      this.c.owns(current) &&
      this.c.planning.toolVisible(current, 'emergence_code_work');
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_code_work',
        description:
          '编程闭环原生记录。begin 建立本任务基线；checks/status 列出真实检查命令、修改版本、退出码、诊断与验证缺口；preview 预览单文件恢复。不会执行项目脚本。',
        parameters: {
          action: { type: 'string', enum: ['begin', 'checks', 'status', 'preview'], required: true },
          objective: { type: 'string' },
          file_path: { type: 'string' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => {
          const work = await this.get(exec.agent!);
          exec.signal.throwIfAborted();
          if (args.action === 'begin')
            return JSON.stringify({
              runId: await work.begin(args.objective ?? '当前编程任务'),
              next: '读取并执行 checks 中与任务相关的检查，建立修改前基线；旧记录不再作为当前任务证据。',
            });
          if (args.action === 'preview') {
            if (!args.file_path) throw new Error('preview 需要 file_path');
            return JSON.stringify(await work.preview(args.file_path));
          }
          const status = await work.status(exec.signal);
          for (const check of status.checks) {
            if (Buffer.byteLength(JSON.stringify(status)) <= 24000) break;
            if (check.latest) {
              check.latest.output = '';
              check.latest.diagnostics = [];
            }
          }
          while (Buffer.byteLength(JSON.stringify(status)) > 24000 && status.checks.length) {
            status.checks.pop();
            status.truncated = true;
            status.verified = false;
          }
          return JSON.stringify(status);
        },
      }),
      { when },
    );
    agent.ctx.tools.register(
      defineTool({
        name: 'emergence_code_restore',
        description:
          '按 preview 的 expectedHash 恢复本次变更中一个既有文本文件；双重核对当前内容和文件系统版本，不删除新增文件，不撤销 Shell 或 Git 操作。遵守编辑权限。',
        parameters: {
          file_path: { type: 'string', required: true },
          expected_hash: { type: 'string', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => {
          const work = await this.get(exec.agent!),
            path = resolve(work.root, args.file_path),
            fs = this.c.ctx.fs;
          if (this.permitted(exec.agent!, 'write', path) !== 'allow')
            throw new Error('恢复需要当前路径的普通 write 权限；不可绕过显式禁止或确认规则');
          const target = await fs.resolve(path),
            info = await fs.stat(target, exec.signal);
          const content = await work.restoreContent(args.file_path, args.expected_hash);
          if (!info || info.type !== 'file') throw new Error('恢复目标不是既有普通文件');
          const current = await fs.readText(target, exec.signal);
          if (digest(current) !== args.expected_hash) throw new Error('恢复目标内容已变化');
          const sandbox = this.c.ctx.get('sandboxPolicy');
          if (fs.sandboxMode !== undefined && !sandbox) throw new Error('恢复缺少文件系统沙箱策略');
          exec.signal.throwIfAborted();
          const change = await work.beforeEdit(args.file_path);
          try {
            if (
              work.root !== (await realpath(this.c.ctx.workingDirectory.get(exec.agent!.session))) ||
              this.permitted(exec.agent!, 'write', path) !== 'allow' ||
              this.permitted(exec.agent!, 'read', path) !== 'allow'
            )
              throw new Error('恢复期间目录或权限发生变化');
            const outcome = await fs.writeText(
              target,
              content,
              { kind: 'replaceIfVersion', version: info.version },
              exec.signal,
              sandbox?.resolve({ session: exec.agent!.session }),
            );
            this.c.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
            await work.afterEdit(change, true);
          } catch (error) {
            await work.afterEdit(change, false);
            throw error;
          }
          return JSON.stringify({
            restored: args.file_path,
            hash: digest(content),
            verification: '文件已恢复；旧检查结果需要重新核对',
          });
        },
      }),
      { when },
    );
  }
  mount() {
    const c = this.c;
    return [
      c.ctx.on('agent/inbox/claimed', ({ agent }) => {
        if (c.owns(agent)) this.register(agent);
      }),
      c.ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
        const rendered = await next();
        if (agent && c.owns(agent) && !c.planning.coordinatorRole(agent)) {
          const work = await this.get(agent),
            run = work.run;
          rendered.sections.push({
            name: 'emergence-code-work',
            text:
              guidance +
              (run
                ? `\n当前代码运行 ${run.id}：已记录 ${run.changes.length} 个文件和 ${run.checks.length} 次检查。压缩/恢复后用 status 重新核对；历史成功不自动复用。`
                : ''),
            interpolate: false,
          });
        }
        return rendered;
      }),
      c.ctx.on('tools/execute', async (exec, next) => {
        if (!exec.agent || !c.owns(exec.agent)) return next();
        const args = toolArguments(exec.arguments),
          path = toolPath(args),
          command = typeof args.command === 'string' ? args.command : '';
        const cwd = c.ctx.workingDirectory.get(exec.agent.session);
        const editing = path && sourceMutation(exec.name, path) && inside(cwd, resolve(cwd, path));
        const checking = ['pwsh', 'bash'].includes(exec.name) && /\b(npm|pnpm|yarn|python)\b/.test(command);
        const control = ['emergence_code_work', 'emergence_code_restore'].includes(exec.name);
        if (!editing && !checking && !control) return next();
        // Parallel calls must never race a baseline, a file snapshot, or a recovery.
        if (this.busy.has(exec.agent)) throw new Error('代码修改/检查正在运行，请等待回执后顺序继续');
        this.busy.add(exec.agent);
        try {
          if (control) return await next();
          const work = await this.get(exec.agent);
          const edit = editing ? await work.beforeEdit(path!) : undefined;
          const check = checking
            ? await work.beforeCheck(
                command,
                exec.signal,
                typeof args.workdir === 'string' ? args.workdir : cwd,
              )
            : undefined;
          try {
            const result = check
              ? await withNativeCheckInputs(
                  check.snapshot.files.map((f) => ({
                    path: f.path,
                    hash: f.hash,
                    state: 'present' as const,
                    bytes: f.bytes,
                  })),
                  next,
                )
              : await next();
            if (edit) await work.afterEdit(edit, !result.isError);
            if (check)
              await work.afterCheck(
                check,
                exec.callId,
                exec.name,
                result.value,
                result.isError,
                exec.signal.aborted,
                result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
              );
            return result;
          } catch (error) {
            if (edit) await work.afterEdit(edit, false);
            if (check)
              await work.afterCheck(
                check,
                exec.callId,
                exec.name,
                {},
                true,
                exec.signal.aborted,
                '工具异常；详见原始工具回执',
              );
            throw error;
          }
        } finally {
          this.busy.delete(exec.agent);
        }
      }),
    ];
  }
}
