import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalPermissionPath } from '../core/adapters/permissions.ts';
import type { SessionController } from './controller.ts';
import {
  describeInstructions,
  directoryChain,
  instructionRoot,
  loadInstructionSnapshot,
} from './instruction-files.ts';
import { digest } from '../platform/content-hash.ts';
import { inside } from '../platform/path-policy.ts';
import { prepareInstructionDraft, writeInstructionDraft, type InitDraft } from './instruction-init.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'emergence-instructions': {
      kind: 'emergence-instructions';
      form: 'instructions';
      fingerprint: string;
      root: string;
    };
  }
}
type ScopeState = { root: string; directories: Set<string> };
export class AgentInstructions {
  private states = new WeakMap<Agent, Promise<ScopeState>>();
  private draft?: InitDraft & { session: string };
  private writing?: Promise<string>;
  constructor(private controller: SessionController) {}
  mount() {
    const c = this.controller;
    return [
      c.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next();
        if (!c.owns(agent) || decision.kind === 'reject') return decision;
        const snapshot = await this.snapshot(agent);
        signal.throwIfAborted();
        const previous = agent.session
          .snapshotEvents()
          .findLast((e) => e.type === 'user/message' && e.data.source.kind === 'emergence-instructions');
        if (
          previous?.type === 'user/message' &&
          previous.data.source.kind === 'emergence-instructions' &&
          previous.data.source.fingerprint === snapshot.fingerprint
        )
          return decision;
        const message = createUserMessage({
          source: {
            kind: 'emergence-instructions',
            form: 'instructions',
            fingerprint: snapshot.fingerprint,
            root: snapshot.root,
          },
          content: [{ type: 'text', text: snapshot.text }],
        });
        return { ...decision, messages: [...decision.messages, message] };
      }),
    ];
  }
  private state(agent: Agent) {
    let state = this.states.get(agent);
    if (!state) {
      state = (async () => {
        const cwd = agent.session.header.cwd ?? this.controller.launch.cwd;
        return {
          root: await instructionRoot(cwd, this.controller.launch.appConfig.instructions.rootMode),
          directories: new Set<string>(),
        };
      })();
      this.states.set(agent, state);
      void state.catch(() => this.states.delete(agent));
    }
    return state;
  }
  async snapshot(agent = this.controller.agent, extra?: string) {
    const state = await this.state(agent),
      cwd = this.controller.ctx.workingDirectory.get(agent.session);
    const dirs = new Set([state.root, ...state.directories]);
    let physical: string;
    try {
      physical = await realpath(cwd);
    } catch {
      physical = cwd;
    }
    directoryChain(state.root, physical).forEach((d) => dirs.add(d));
    if (extra) directoryChain(state.root, extra).forEach((d) => dirs.add(d));
    const snapshot = await loadInstructionSnapshot(
      this.controller.launch.home,
      state.root,
      [...dirs],
      this.controller.launch.appConfig.instructions,
    );
    if (!inside(state.root, physical)) {
      snapshot.warnings.push('当前工作目录已离开固定项目根；未加载外部项目规则。请 /project 打开目标项目。');
      snapshot.text +=
        '\nCurrent working directory is outside the fixed project scope. External project instructions are not loaded; open the intended project explicitly.';
      snapshot.fingerprint = digest(snapshot.fingerprint + snapshot.text);
    }
    return snapshot;
  }
  async prepareTool(exec: ToolExecution): Promise<string | undefined> {
    if (
      !exec.agent ||
      ![
        'read',
        'read_image',
        'write',
        'edit',
        'glob',
        'grep',
        'emergence_code_project',
        'emergence_code_locate',
        'emergence_code_context',
        'emergence_code_work',
        'emergence_code_restore',
        'emergence_data_analyze',
        'emergence_data_profile',
        'emergence_data_query',
      ].includes(exec.name)
    )
      return;
    const args = exec.arguments as Record<string, unknown>,
      raw = args.file_path ?? args.path;
    if (typeof raw !== 'string') return;
    const state = await this.state(exec.agent),
      cwd = this.controller.ctx.workingDirectory.get(exec.agent.session);
    let target: string;
    try {
      target = canonicalPermissionPath(raw, cwd);
    } catch {
      return;
    }
    // Outside-project tools keep their E2 approval policy; their files never supply project instructions.
    if (!inside(state.root, target)) return;
    let dir = dirname(target);
    try {
      if ((await stat(target)).isDirectory()) dir = target;
    } catch {}
    const chain = directoryChain(state.root, dir);
    if (new Set([...state.directories, ...chain]).size > 63)
      return '目录规则作用域达到上限，请新建会话或缩小任务范围';
    chain.forEach((d) => state.directories.add(d));
    const snapshot = await this.snapshot(exec.agent);
    if (!['write', 'edit'].includes(exec.name)) return;
    if (
      snapshot.sources.some(
        (s) => ['error', 'skipped'].includes(s.status) && (s.scope === '*' || inside(s.scope, target)),
      ) ||
      snapshot.warnings.length
    )
      return '相关规则未完整加载，已阻止写入；请 /instructions 检查文件、预算或目录边界';
    const previous = exec.agent.session
      .snapshotEvents()
      .findLast((e) => e.type === 'user/message' && e.data.source.kind === 'emergence-instructions');
    if (
      snapshot.sources.some((s) => s.status === 'loaded') &&
      (previous?.type !== 'user/message' ||
        previous.data.source.kind !== 'emergence-instructions' ||
        previous.data.source.fingerprint !== snapshot.fingerprint)
    ) {
      return '发现新的或已修改的目录规则，本次写入未执行。下一模型请求将载入最新规则；请先阅读规则，再重新提交操作。';
    }
  }
  async command(command: string, args: string[]) {
    const c = this.controller;
    if (command === '/instructions') {
      if (args[0] === 'config')
        return (
          JSON.stringify(c.launch.appConfig.instructions, null, 2) +
          '\n在 config.json 的 instructions 中配置；/settings reload 空闲时应用。CLAUDE.md 默认关闭，AGENTS.md 默认兼容。'
        );
      if (args[0] === 'reload') {
        this.draft = undefined;
        if (c.busy) return '规则将在下一模型请求前重新读取；当前已发送的请求保持原快照。';
      } else if (args[0] && args[0] !== 'path')
        throw new Error('用法：/instructions [reload|path "文件或目录"]');
      let extra: string | undefined;
      if (args[0] === 'path') {
        if (!args[1]) throw new Error('请指定项目内路径');
        const path = canonicalPermissionPath(args[1], c.cwd),
          state = await this.state(c.agent);
        if (!inside(state.root, path)) throw new Error('路径超出当前项目规则边界');
        extra = dirname(path);
        try {
          if ((await stat(path)).isDirectory()) extra = path;
        } catch {}
        const chain = directoryChain(state.root, extra);
        if (new Set([...state.directories, ...chain]).size > 63)
          throw new Error('规则作用域过多，请缩小范围或新建会话');
        chain.forEach((dir) => state.directories.add(dir));
      }
      return describeInstructions(await this.snapshot(c.agent, extra));
    }
    if (command !== '/init') throw new Error('未知规则命令');
    if (c.busy || c.pending || this.writing) throw new Error('请先等待当前窗口任务或确认结束，再初始化规则');
    if (args[0] === 'apply') {
      const draft = this.draft;
      if (!draft || draft.session !== c.id) throw new Error('请先 /init 查看本会话的具体草案');
      this.writing = (async () => {
        let backup: string | undefined;
        await c.writeWithPermission(draft.target, draft.content, async () => {
          backup = await writeInstructionDraft(draft);
        });
        this.draft = undefined;
        return `已保存 ${draft.target}${backup ? '\n原文件备份：' + backup : ''}\n下一模型请求前加载新规则；/instructions 查看来源。`;
      })();
      try {
        return await this.writing;
      } finally {
        this.writing = undefined;
      }
    }
    if (args[0] && !['personal', 'local'].includes(args[0]))
      throw new Error('用法：/init [personal|local] 预览；/init apply 写入');
    const state = await this.state(c.agent),
      draft = await prepareInstructionDraft(
        state.root,
        c.launch.home,
        args[0] === 'personal' ? 'personal' : args[0] === 'local' ? 'local' : 'project',
        c.launch.appConfig.instructions.maxFileBytes,
      );
    this.draft = { ...draft, session: c.id! };
    return `规则草案：${draft.target}\n${draft.previous === undefined ? '新建文件' : draft.previous === draft.content ? '已有初始化段，原文保持不变' : '保留全部原文，并追加以下初始化段'} · ${draft.bytes} 字节\n\n${draft.previous === undefined ? draft.content : draft.content.slice(draft.previous.length) || draft.content}\n\n/init apply 按当前编辑权限写入；预览后文件变化会拒绝覆盖。`;
  }
  get initializing() {
    return !!this.writing;
  }
  reconfigure() {
    this.states = new WeakMap();
    this.draft = undefined;
  }
  async settle() {
    await this.writing?.catch(() => {});
  }
}
