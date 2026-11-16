import { z } from 'zod';
import { permissionFingerprint } from '../adapters/permissions.ts';
import { safeError } from '../adapters/redaction.ts';
import { settledTaskStatuses as terminal, type TaskRecord } from '../domain/task.ts';
import { digest } from '../storage/execution-journal.ts';
import { fileFingerprint } from './execution-evidence.ts';
import { RunDiagnosticsStore } from '../storage/run-diagnostics-store.ts';
import type { Collaboration } from './task-coordinator.ts';
const bounded = (value: unknown, length = 1000) => safeError(value).slice(0, length);

type Host = Pick<
  Collaboration,
  | 'task'
  | 'journal'
  | 'workspace'
  | 'state'
  | 'stopped'
  | 'changed'
  | 'kick'
  | 'enqueue'
  | 'checkpoint'
  | 'lifecycle'
>;
/** TaskRecovery: one owner for this responsibility; shares the authoritative task graph. */
export class TaskRecovery {
  private readonly pending = new Map<string, { key: string; result: Promise<TaskRecord | undefined> }>();
  constructor(private host: Host) {}
  async recoveryFacts(id: string) {
    const task = this.host.task(id),
      effects = this.host.journal.effects(id);
    const files = [...new Set(effects.flatMap((e) => (e.file ? [e.file] : [])))];
    const observations = await Promise.all(
      files.slice(0, 50).map(async (path) => ({ path, current: await fileFingerprint(path) })),
    );
    return {
      task: task.id,
      state: task.status,
      run: task.runId,
      fence: task.fence,
      session: task.targetSession,
      model: task.modelId,
      category:
        task.recovery === 'uncertain' || effects.some((e) => ['started', 'uncertain'].includes(e.state))
          ? 'uncertain'
          : effects.length
            ? 'effects-returned'
            : task.messageId
              ? 'no-recorded-effects'
              : 'not-started',
      effects,
      observations,
      omittedFiles: Math.max(0, files.length - 50),
      log: { session: task.targetSession, from: task.fromSeq, to: task.result?.toSeq },
      diagnostic: await new RunDiagnosticsStore(this.host.workspace.launch.home)
        .read(task.targetSession)
        .then((runs) => runs.filter((run) => run.task === task.id))
        .catch(() => '阶段计时未能读取，保留原记录；不能据此判断是否发生副作用'),
      cost: 'unknown',
      tokens: 'unknown',
    };
  }
  async recover(id: string, requester: string, evidence: string, retry = true) {
    const key = digest([requester, evidence, retry]);
    const pending = this.pending.get(id);
    if (pending) {
      if (pending.key !== key) throw new Error('该任务已有不同的恢复请求正在处理');
      return pending.result;
    }
    const result = this.performRecovery(id, requester, evidence, retry).finally(() =>
      this.pending.delete(id),
    );
    this.pending.set(id, { key, result });
    return result;
  }
  private async performRecovery(id: string, requester: string, evidence: string, retry: boolean) {
    const task = this.host.task(id),
      source = this.host.workspace.panes.get(requester)?.controller;
    if (!source || requester !== task.issuer || source.id !== task.issuerSession)
      throw new Error('只能在原派发会话中决定恢复');
    const existing = retry && this.host.state.tasks.find((candidate) => candidate.recoveryOf === id);
    if (existing) return existing;
    if (retry && (!['interrupted', 'blocked'].includes(task.status) || task.cancelReason))
      throw new Error('仅可恢复未取消的中断或阻塞任务');
    if (!retry && (!terminal.has(task.status) || task.recovery !== 'uncertain'))
      throw new Error('当前任务没有需要人工解除的不确定状态');
    if (retry && (task.recoveryCount >= 2 || this.host.state.tasks.some((t) => t.recoveryOf === id)))
      throw new Error('已创建恢复尝试或恢复预算耗尽');
    const note = z.string().trim().min(8).max(4000).parse(evidence),
      facts = await this.recoveryFacts(id),
      factsHash = digest(facts);
    const targetBinding = () => {
      const pane = this.host.workspace.panes.get(task.target);
      return [task, pane?.controller?.id, pane?.cwd, pane?.modelId, pane?.controller?.permissionSnapshot()];
    };
    const stamp = permissionFingerprint([
        source.permissionSnapshot(),
        ...source.permissionConstraints(source.agent),
      ]),
      binding = digest(targetBinding());
    const valid = () =>
      !this.host.stopped &&
      stamp ===
        permissionFingerprint([source.permissionSnapshot(), ...source.permissionConstraints(source.agent)]) &&
      binding === digest(targetBinding());
    if (
      !(await source.confirmDecision(
        `核对任务 ${id} · ${retry ? `将创建第 ${task.recoveryCount + 1}/2 次恢复尝试` : '保留当前结果，解除待核对标记；不重试、不自动验收'}\n${task.objective}\n${task.cwd}\n事实分类：${{ uncertain: '副作用结果不确定', 'effects-returned': '副作用已有返回记录', 'no-recorded-effects': '没有副作用记录（不等于未发生）', 'not-started': '尚未派发' }[facts.category]}\n已记录 ${facts.effects.length} 个副作用调用；可能已经发生的外部操作不会撤销。\n${facts.observations.map((o) => `${o.path}\n当前摘要 ${o.current}`).join('\n')}\n核对说明：${note}\n${retry ? '确认表示接受新尝试可能重复副作用；原权限和任务范围继续生效。' : '仅在已确认外部操作和后台进程状态后继续。'}`,
        valid,
      ))
    )
      return;
    if (!valid() || digest(await this.recoveryFacts(id)) !== factsHash)
      throw new Error('核对后事实已变化，旧确认失效');
    this.host.journal.decision(id, {
      action: retry ? 'retry' : 'keep',
      evidence: bounded(note, 4000),
      factsHash,
      epoch: this.host.journal.epoch,
    });
    const previous = task.recovery;
    this.host.lifecycle.amend(task, { recovery: 'reconciled' });
    if (!retry) {
      this.host.lifecycle.amend(task, { progress: '用户已核对不确定操作，保留当前结果；未自动验收' });
      await this.host.workspace.save();
      this.host.changed();
      this.host.kick();
      return task;
    }
    try {
      return await this.host.enqueue(
        task.issuer,
        task.target,
        'recover-' + id,
        task.objective,
        task.dependsOn,
        task.contract,
        undefined,
        {
          local: task.local,
          workflow: task.workflow,
          recoveryOf: id,
          followup: `恢复 ${id}：${note}\n已有副作用记录摘要：${factsHash}。操作可能已发生，执行前先核对，不要盲目重复。`,
        },
      );
    } catch (e) {
      this.host.lifecycle.amend(task, { recovery: previous });
      this.host.checkpoint();
      throw e;
    }
  }
}
