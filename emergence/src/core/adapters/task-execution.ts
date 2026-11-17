import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileFingerprint, sideEffectTool } from '../application/execution-evidence.ts';
import { allocationViolation } from '../application/task-allocation.ts';
import type { TaskEngine } from '../application/task-engine.ts';
import {
  isReadOnlyTask,
  taskLabels,
  settledTaskStatuses as terminal,
  type TaskRecord,
} from '../domain/task.ts';
import { toolArguments, toolContract, toolOutcome, toolPath } from '../domain/tool-contract.ts';
import { digest, type ExecutionEffect } from '../storage/execution-journal.ts';
import { safeError } from './redaction.ts';
import { taskFailures } from '../application/task-failures.ts';
const now = () => new Date().toISOString();
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);

type Host = Pick<
  TaskEngine,
  | 'lifecycle'
  | 'dependency'
  | 'assurance'
  | 'active'
  | 'journal'
  | 'workspace'
  | 'update'
  | 'stopped'
  | 'state'
  | 'track'
  | 'kick'
  | 'view'
  | 'changed'
  | 'current'
  | 'journalReady'
  | 'checkpoint'
  | 'cancel'
  | 'budgets'
>;
/** TaskExecution: one owner for this responsibility; shares the authoritative task graph. */
export class TaskExecution {
  readonly finishing = new Set<TaskRecord>();
  readonly readOnlyToolMasks = new Map<TaskRecord, () => void>();
  readonly childTasks = new WeakMap<Agent, TaskRecord>();
  readonly approvals = new WeakMap<object, boolean>();

  constructor(private host: Host) {}
  private dispatching(task: TaskRecord) {
    return (
      this.host.active.get(task.target) === task &&
      task.status === 'dispatching' &&
      !task.cancelReason &&
      !this.host.stopped
    );
  }
  private async dependencyIssue(task: TaskRecord) {
    for (const id of task.dependsOn) {
      try {
        await this.host.assurance.version(this.host.dependency(id));
      } catch {
        return '依赖输入、口径或交付产物已变化，旧验收不能用于本次执行';
      }
    }
    for (const id of task.dependsOn)
      for (const artifact of this.host.dependency(id).artifactVersions)
        if (artifact.hash.startsWith('unknown:') || artifact.hash !== (await fileFingerprint(artifact.path)))
          return '依赖产物已变化或无法读取，旧验收不能用于本次执行';
  }
  async start(task: TaskRecord) {
    if (task.assessment || task.issuer !== task.target || task.issuerSession !== task.targetSession)
      throw new Error('历史跨窗口任务只能查看，不能重新执行');
    if (
      this.host.stopped ||
      task.cancelReason ||
      task.status !== 'queued' ||
      this.host.active.has(task.target)
    )
      return;
    const dependencies = task.dependsOn.map((id) => {
      const d = this.host.dependency(id);
      return {
        id: d.id,
        requestedDependency: id,
        objective: d.objective.slice(0, 600),
        status: d.status,
        result: d.result
          ? {
              summary: d.result.summary.slice(0, 1200),
              artifacts: d.result.artifacts.slice(0, 5),
              errors: d.result.errors.slice(0, 3),
              code: d.result.code,
              data: this.host.assurance.dataDeliveries(d),
            }
          : null,
      };
    });
    const message = createUserMessage({
      source: { kind: 'emergence-task', taskId: task.id },
      content: [
        {
          type: 'text',
          text: `[Emergence task ${task.id}]\n${task.objective}\n\n工作目录：${task.cwd}\n完成后用 emergence_report 报告，失败必须说明。${dependencies.length ? '\n依赖任务实际回执：' + JSON.stringify(dependencies) : ''}`,
        },
      ],
    });
    this.host.active.set(task.target, task);
    this.host.lifecycle.transition(task, 'dispatching');
    this.host.lifecycle.amend(task, { messageId: message.id });
    this.host.lifecycle.amend(task, { startedAt: now() });
    this.host.lifecycle.amend(task, { runId: randomUUID() });
    this.host.lifecycle.amend(task, { fence: this.host.journal.epoch });
    const controller = this.host.workspace.panes.get(task.target)!.controller!;
    this.host.lifecycle.amend(task, { fromSeq: controller.agent.session.snapshotEvents().at(-1)?.seq ?? 0 });
    this.host.update(task, '已记录派发意图');
    try {
      await this.host.workspace.save();
      if (!this.dispatching(task)) return;
      const issue = await this.dependencyIssue(task);
      // Observation is asynchronous; cancellation owns settlement and late results
      // must not revive the task, overwrite its outcome or inject unowned work.
      if (!this.dispatching(task)) return;
      if (issue) {
        await this.finishWithoutTurn(task, 'blocked', issue);
        return;
      }
      const pane = this.host.workspace.panes.get(task.target);
      if (
        pane?.controller !== controller ||
        controller.id !== task.targetSession ||
        controller.cwd !== task.cwd ||
        pane.modelId !== task.modelId ||
        task.fence !== this.host.journal.epoch
      )
        throw new Error('派发前执行窗口或租约已变化，未启动任务');
      if (this.host.state.paused || controller.busy || !this.host.workspace.available(task.target)) {
        this.host.active.delete(task.target);
        this.host.lifecycle.transition(task, 'queued');
        this.host.update(task, '派发暂停或窗口忙碌，尚未执行');
        return;
      }
      if (!process.env[controller.model.apiKeyEnv])
        throw new Error(`模型密钥未配置：${controller.model.apiKeyEnv}`);
      controller.lastError = undefined;
      if (isReadOnlyTask(task)) {
        // The read-only audit menu must agree with its inherited permission policy.
        // Native guards still reject forged/hidden calls; no failed receipt is discarded.
        const deny = this.host.workspace.ctx.tools
          .definitions()
          .filter((tool) => {
            const contract = toolContract(tool.name);
            return contract.permission !== 'read' || contract.sideEffect;
          })
          .map((tool) => tool.name);
        if (deny.length) this.readOnlyToolMasks.set(task, controller.agent.ctx.tools.restrict({ deny }));
      }
      controller.notice = `执行计划任务 ${task.id}`;
      controller.changed();
      if (!this.dispatching(task)) return;
      controller.agent.followup(message);
      void controller.agent.whenIdle().then(() => {
        if (
          this.host.active.get(task.target) === task &&
          !terminal.has(task.status) &&
          !this.finishing.has(task)
        )
          void this.host.track(
            this.finishWithoutTurn(
              task,
              task.cancelReason ? 'cancelled' : 'needs_review',
              task.cancelReason ?? '执行已空闲但未收到对应轮次的结束回执',
            ),
          );
        this.host.kick();
      });
    } catch (error) {
      if (this.dispatching(task)) await this.finishWithoutTurn(task, 'failed', bounded(error));
    }
  }
  async finish(task: TaskRecord, event: Extract<SessionEvent, { type: 'turn/end' }>) {
    if (
      this.host.active.get(task.target) !== task ||
      terminal.has(task.status) ||
      this.finishing.has(task) ||
      task.fence !== this.host.journal.epoch
    )
      return;
    this.finishing.add(task);
    try {
      const controller = this.host.workspace.panes.get(task.target)?.controller;
      const events =
        controller?.agent.session
          .snapshotEvents()
          .filter((e) => 'turn' in e.data && e.data.turn === task.turn) ?? [];
      const additionalErrors: string[] = [];
      // Expected failing reproductions remain in the log. Only the same host-bound check,
      // with unchanged test criteria and a fresh successful rerun, resolves a nonzero exit.
      const repairedChecks = new Map<string, string>();
      let codeResult: NonNullable<TaskRecord['result']>['code'] | undefined;
      try {
        const evidence = controller ? await controller.codeWork.evidence(controller.agent) : undefined;
        for (const [failed, succeeded] of evidence?.repairedChecks ?? [])
          repairedChecks.set(failed, succeeded);
        codeResult = evidence?.result;
        if (evidence?.unverifiedChanges)
          additionalErrors.push(
            '代码变更尚缺当前版本的成功检查或测试口径发生变化；请查看 emergence_code_work status',
          );
      } catch {
        additionalErrors.push('无法核对代码检查记录；不得将未知状态视为通过');
      }
      if (
        controller &&
        this.host.workspace.ctx.agents
          .list()
          .some((agent) => agent !== controller.agent && controller.owns(agent) && agent.status === 'running')
      )
        additionalErrors.push('仍有子代理在运行，不能确认其最终结果');
      const text =
        events
          .flatMap((e) =>
            e.type === 'assistant/message'
              ? e.data.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))
              : [],
          )
          .at(-1) ?? '';
      const reason = event.data.reason;
      if (reason.kind === 'completed' && !task.report)
        additionalErrors.push('任务轮次结束但未提交 emergence_report，不能确认目标已完成');
      if (reason.kind !== 'completed' && reason.kind !== 'aborted')
        additionalErrors.unshift(bounded(JSON.stringify(reason)));
      const failures = [
        ...(await taskFailures(task, events, repairedChecks)),
        ...additionalErrors.map((detail) => ({ detail })),
      ];
      const errors = failures
        .filter((failure) => !('resolution' in failure && failure.resolution))
        .map((failure) => failure.detail);
      let status: TaskRecord['status'] =
        task.cancelReason || reason.kind === 'aborted'
          ? 'cancelled'
          : reason.kind !== 'completed' || task.report?.outcome === 'failed'
            ? 'failed'
            : errors.length
              ? 'needs_review'
              : 'succeeded';
      const result: NonNullable<TaskRecord['result']> = {
        summary: bounded(task.report?.summary || text || `轮次结束：${reason.kind}`, 8000),
        errors: errors.slice(0, 20),
        failures:
          failures.length <= 128
            ? failures
            : [...failures.slice(0, 127), { detail: '失败观察超过记录上限，需要拆分任务核对' }],
        artifacts: task.report?.artifacts ?? [],
        fromSeq: task.fromSeq,
        toSeq: event.seq,
        ...(codeResult ? { code: codeResult } : {}),
      };
      if (task.contract && status === 'succeeded') status = 'needs_review';
      const files = [
        ...new Set(
          this.host.journal.effects(task.id).flatMap((effect) => (effect.file ? [effect.file] : [])),
        ),
      ].slice(0, 30);
      const artifactVersions = await Promise.all(
        files.map(async (path) => ({ path, hash: await fileFingerprint(path) })),
      );
      // Commit observations together only while this attempt still owns settlement.
      if (
        this.host.active.get(task.target) !== task ||
        terminal.has(task.status) ||
        task.fence !== this.host.journal.epoch
      )
        return;
      this.host.lifecycle.amend(task, { result, artifactVersions });
      status = task.cancelReason ? 'cancelled' : status;
      if (this.host.journal.effects(task.id).some((e) => ['started', 'uncertain'].includes(e.state))) {
        this.host.lifecycle.amend(task, { recovery: 'uncertain' });
        if (status === 'succeeded') status = 'needs_review';
      }
      this.host.lifecycle.transition(task, status);
      this.host.lifecycle.amend(task, { endedAt: now() });
      this.host.update(
        task,
        task.cancelReason ?? (errors.length ? '工具或轮次存在失败，请检查实际回执' : taskLabels[task.status]),
      );
      await this.settled(task);
    } finally {
      this.finishing.delete(task);
    }
  }
  async finishWithoutTurn(task: TaskRecord, status: TaskRecord['status'], reason: string) {
    if (terminal.has(task.status)) return;
    if (this.host.journal.effects(task.id).some((e) => ['started', 'uncertain'].includes(e.state)))
      this.host.lifecycle.amend(task, { recovery: 'uncertain' });
    this.host.lifecycle.transition(task, status);
    this.host.lifecycle.amend(task, { endedAt: now() });
    this.host.update(task, reason);
    this.host.lifecycle.amend(task, {
      result: {
        summary: bounded(reason, 8000),
        errors: status === 'failed' || status === 'needs_review' ? [bounded(reason)] : [],
        artifacts: [],
        fromSeq: task.fromSeq,
        toSeq: task.fromSeq,
      },
    });
    await this.settled(task);
  }
  async settled(task: TaskRecord) {
    try {
      await this.host.workspace.ctx.sessionPersistence.flush();
      await this.host.workspace.save();
    } finally {
      this.readOnlyToolMasks.get(task)?.();
      this.readOnlyToolMasks.delete(task);
      if (this.host.active.get(task.target) === task) this.host.active.delete(task.target);
      this.host.changed();
      this.host.kick();
    }
  }
  mount() {
    const workspace = this.host.workspace,
      ctx = workspace.ctx;
    const disposers: Array<() => void> = [];
    disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        const pane = [...workspace.panes.values()].find((p) => p.controller?.owns(agent));
        const task = pane && this.host.current(pane.id);
        if (task?.cancelReason) throw new Error(task.cancelReason);
        if (task && task.targetSession !== agent.session.id) this.childTasks.set(agent, task);
        return undefined;
      }),
    );
    disposers.push(
      ctx.tools.guard((exec) => {
        const task = exec.agent && this.childTasks.get(exec.agent);
        if (
          task &&
          (this.host.current(task.target) !== task ||
            task.fence !== this.host.journal.epoch ||
            this.host.stopped)
        )
          return '子代理所属尝试已结束，禁止过期执行器继续操作';
      }),
    );
    disposers.push(
      ctx.tools.guard((exec) => {
        const pane = [...workspace.panes.values()].find((p) => p.controller?.owns(exec.agent)),
          task = pane && this.host.current(pane.id);
        return (
          task &&
          allocationViolation(task, exec.name, exec.arguments, ctx.workingDirectory.get(exec.agent!.session))
        );
      }),
    );
    disposers.push(
      ctx.on('tools/execute', async (exec, next) => {
        const pane = [...workspace.panes.values()].find((p) => p.controller?.owns(exec.agent)),
          task = pane && this.host.current(pane.id);
        if (task) {
          const reason = allocationViolation(
            task,
            exec.name,
            exec.arguments,
            ctx.workingDirectory.get(exec.agent!.session),
          );
          if (reason) throw new Error(reason);
        }
        if (!task || !sideEffectTool(exec.name, exec.arguments) || !exec.agent) return next();
        if (!this.host.journalReady || this.host.stopped || task.fence !== this.host.journal.epoch)
          throw new Error('执行租约无效，工具未运行');
        if (this.host.journal.effects(task.id).length >= 1000) throw new Error('任务副作用调用预算已耗尽');
        const args = exec.arguments as Record<string, unknown>;
        const filePath = toolPath(args),
          contract = toolContract(exec.name, args);
        const file =
          contract.operation === 'write' && contract.resource === 'file' && filePath !== undefined
            ? resolve(ctx.workingDirectory.get(exec.agent.session), filePath)
            : undefined;
        const effect: ExecutionEffect = {
          id: digest([task.runId, exec.agent.id, exec.callId]),
          task: task.id,
          run: task.runId!,
          actor: exec.agent.session.id,
          call: exec.callId,
          tool: exec.name,
          argumentsHash: digest(exec.arguments),
          state: 'started',
          at: now(),
          ...(file ? { file, before: await fileFingerprint(file) } : {}),
        };
        if (this.host.current(task.target) !== task || task.cancelReason || this.host.stopped)
          throw new Error('任务已取消或执行归属已变化');
        await this.host.workspace.ctx.sessionPersistence.flush();
        if (this.host.current(task.target) !== task || task.cancelReason || this.host.stopped)
          throw new Error('持久化期间任务已取消');
        this.host.checkpoint();
        this.host.journal.effect(effect);
        try {
          const result = await next(),
            value = result.value;
          const outcome = toolOutcome(exec.name, value, !!result.isError, exec.signal.aborted);
          effect.state =
            outcome === 'pending' || outcome === 'cancelled'
              ? 'uncertain'
              : outcome === 'failed'
                ? 'failed'
                : 'returned';
          effect.resultHash = digest(result);
          if (file) effect.after = await fileFingerprint(file);
          this.host.journal.effect(effect);
          return result;
        } catch (e) {
          effect.state = 'uncertain';
          this.host.journal.effect(effect);
          throw e;
        }
      }),
    );
    disposers.push(
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        const bound = this.childTasks.get(agent);
        if (bound && (this.host.current(bound.target) !== bound || this.host.stopped))
          throw new Error('子代理所属任务已失效');
        const pane = [...workspace.panes.values()].find((p) => p.controller?.owns(agent));
        const task = pane && this.host.current(pane.id);
        if (task?.contract) {
          if (task.steps >= task.contract.maxSteps) throw new Error('任务模型步数预算已耗尽');
          this.host.lifecycle.amend(task, { steps: task.steps + 1 });
          this.host.changed();
        }
        return next();
      }),
    );
    disposers.push(
      ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
        const task = [...this.host.active.values()].find(
          (t) => t.targetSession === agent.session.id && t.messageId === message.id,
        );
        if (task) {
          this.host.lifecycle.amend(task, { turn: turn });
          this.host.lifecycle.transition(task, 'running');
          this.host.update(task, '执行中');
        }
      }),
    );
    disposers.push(
      ctx.on('session/event', (session, event) => {
        if (event.type === 'approval/decided' && ['rejected', 'cancelled'].includes(event.data.outcome)) {
          const agent = ctx.agents.list().find((agent) => agent.session.id === session.id);
          const task =
            (agent && this.childTasks.get(agent)) ??
            [...this.host.active.values()].find((t) => t.targetSession === session.id);
          const turn = session.snapshotEvents().findLast((e) => e.type === 'turn/start')?.seq;
          const asked = session
            .snapshotEvents()
            .find((e) => e.type === 'approval/asked' && e.data.id === event.data.id);
          // Only this run's tool approval can stop it; old decisions and host-only questions cannot.
          if (
            task &&
            this.host.current(task.target) === task &&
            !task.cancelReason &&
            asked?.type === 'approval/asked' &&
            asked.data.callId &&
            session
              .snapshotEvents()
              .some(
                (e) => e.type === 'tool/call' && e.data.turn === turn && e.data.callId === asked.data.callId,
              )
          ) {
            const reason = '用户拒绝或取消本任务操作，已停止；不会自动重试或扩大权限';
            this.host.lifecycle.amend(task, { cancelReason: reason });
            void this.host.track(this.host.cancel(task.id, reason));
          }
        }
        const task = [...this.host.active.values()].find(
          (t) =>
            t.targetSession === session.id &&
            t.turn !== undefined &&
            'turn' in event.data &&
            event.data.turn === t.turn,
        );
        if (!task || terminal.has(task.status)) return;
        if (event.type === 'tool/call') this.host.update(task, `执行工具 ${event.data.name}`);
        if (event.type === 'turn/end') void this.host.track(this.finish(task, event));
      }),
    );
    disposers.push(
      ctx.on('tools/result', (exec, result) => {
        const pane = [...workspace.panes.values()].find((p) => p.controller?.owns(exec.agent));
        const task = pane ? this.host.active.get(pane.id) : undefined;
        if (exec.agent && this.childTasks.has(exec.agent) && this.childTasks.get(exec.agent) !== task) return;
        if (!task || terminal.has(task.status)) return undefined;
        if (
          task &&
          !terminal.has(task.status) &&
          result.isError &&
          exec.agent?.session.id !== task.targetSession &&
          task.executionIssues.length < 20
        ) {
          this.host.lifecycle.append(task, 'executionIssues', {
            callId: exec.callId,
            tool: exec.name,
            detail: bounded(
              `子代理 ${exec.agent?.session.id} 工具 ${exec.name} 失败：` +
                result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
            ),
          });
        }
        if (
          !result.isError &&
          toolContract(exec.name, exec.arguments).evidence === 'command' &&
          toolOutcome(exec.name, result.value, false, exec.signal.aborted) !== 'succeeded'
        ) {
          const exitCode = toolArguments(result.value).exitCode;
          if (task.executionIssues.length < 20)
            this.host.lifecycle.append(task, 'executionIssues', {
              callId: exec.callId,
              tool: exec.name,
              detail: bounded(
                `${exec.name}: 命令未取得成功完成回执（${toolOutcome(exec.name, result.value, false, exec.signal.aborted)}）；exit code: ${typeof exitCode === 'number' ? exitCode : 'unknown'}`,
              ),
            });
          this.host.update(task, '命令的结构化执行回执需要检查');
        }
        return undefined;
      }),
    );
    const changed = (id: string) => {
      const task = this.host.active.get(id),
        pane = workspace.panes.get(id);
      if (task && !terminal.has(task.status) && task.turn !== undefined) {
        const status = pane?.controller?.pending ? 'waiting_user' : 'running';
        if (task.status !== status) {
          this.host.lifecycle.transition(task, status);
          this.host.update(task, status === 'waiting_user' ? '等待所属窗口的用户回答' : '执行中');
        }
      }
      if (pane?.controller) {
        const waiting = !!pane.controller.pending;
        if (this.approvals.get(pane.controller) !== waiting) {
          this.approvals.set(pane.controller, waiting);
          for (const queued of this.host.state.tasks)
            if (queued.status === 'queued') this.host.budgets.account(queued);
        }
      }
      this.host.kick();
    };
    workspace.on('session-change', changed);
    disposers.push(() => workspace.off('session-change', changed));

    return disposers;
  }
  close() {
    for (const dispose of this.readOnlyToolMasks.values()) dispose();
    this.readOnlyToolMasks.clear();
  }
}
