import { createHash } from 'node:crypto';
import {
  comparePermission,
  instructionLayers,
  observationSchema,
  observationSnapshotSchema,
  type CoreCatalog,
  type CoreMode,
  type Observation,
  type ObservationSnapshot,
  type PermissionFact,
} from '../domain/contracts.ts';
import type { HarnessObservationPort, ObservationStore } from './ports.ts';

const keyOf = (value: string) => createHash('sha256').update(value).digest('hex');
export class CoreObserver implements HarnessObservationPort {
  private snapshot?: ObservationSnapshot;
  private binding?: { session: string; project: string };
  private pending?: ObservationSnapshot;
  private writing?: Promise<void>;
  private stopped = false;
  private storeBlocked = false;
  private seen = new Set<string>();
  private diagnostic?: string;
  constructor(
    readonly catalog: CoreCatalog | undefined,
    public mode: CoreMode,
    private store: ObservationStore,
    assetError?: string,
  ) {
    this.diagnostic = assetError;
  }
  get enabled() {
    return this.mode === 'observe' && Boolean(this.catalog) && !this.stopped;
  }
  async bind(session: string, project: string) {
    await this.settle();
    this.binding = { session, project };
    this.seen.clear();
    this.storeBlocked = false;
    if (this.catalog) this.diagnostic = undefined;
    const scopeKey = keyOf(JSON.stringify([project, session]));
    this.snapshot = {
      schemaVersion: 1,
      policyVersion: 'emergence-core-0.2.0',
      purpose: 'observation-only-not-execution-checkpoint',
      scopeKey,
      lastSequence: 0,
      events: [],
    };
    if (!this.enabled) return;
    try {
      const saved = await this.store.read(scopeKey);
      if (saved) {
        const parsed = observationSnapshotSchema.parse(saved);
        if (parsed.scopeKey !== scopeKey) throw new Error('scope mismatch');
        this.snapshot = parsed;
      }
    } catch {
      this.storeBlocked = true;
      this.diagnostic = 'CORE_STORE_READ_FAILED';
    }
    this.record({ kind: 'observer-bound', actorKey: keyOf(session) });
  }
  async setMode(mode: CoreMode) {
    await this.settle();
    this.mode = mode;
    if (mode === 'observe' && this.binding) await this.bind(this.binding.session, this.binding.project);
  }
  private record(input: Omit<Observation, 'sequence' | 'at'>) {
    if (!this.enabled || !this.snapshot) return;
    try {
      const event = observationSchema.parse({
        ...input,
        sequence: this.snapshot.lastSequence + 1,
        at: new Date().toISOString(),
      });
      this.snapshot = {
        ...this.snapshot,
        lastSequence: event.sequence,
        events: [...this.snapshot.events, event].slice(-128),
      };
      if (!this.storeBlocked) {
        this.pending = structuredClone(this.snapshot);
        void this.flush();
      }
    } catch {
      this.diagnostic = 'CORE_OBSERVATION_INVALID';
    }
  }
  modelStep(actor: string) {
    this.record({ kind: 'model-step', actorKey: keyOf(actor) });
  }
  permissionCheck(actor: string, callKey: string, fact: PermissionFact) {
    if (!this.enabled) return;
    try {
      const key = keyOf(actor + ':' + callKey + ':' + JSON.stringify(fact));
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      this.record({
        kind: 'permission-check',
        actorKey: keyOf(actor),
        toolKind: fact.toolKind,
        legacyDecision: fact.legacyDecision,
        ...comparePermission(fact),
      });
    } catch {
      this.diagnostic = 'CORE_OBSERVATION_INVALID';
    }
  }
  toolFinished(actor: string) {
    this.record({ kind: 'tool-finished', actorKey: keyOf(actor) });
  }
  idle(actor: string) {
    this.record({ kind: 'run-idle', actorKey: keyOf(actor) });
  }
  error(actor: string) {
    this.record({ kind: 'run-error', actorKey: keyOf(actor) });
  }
  flush(): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        try {
          await this.store.write(next);
        } catch {
          this.diagnostic = 'CORE_STORE_WRITE_FAILED';
          this.storeBlocked = true;
          this.pending = undefined;
        }
      }
    })().finally(() => {
      this.writing = undefined;
      if (this.pending) void this.flush();
    });
    return this.writing;
  }
  async settle() {
    while (this.writing || this.pending) await this.flush();
  }
  async close() {
    this.stopped = true;
    await this.settle();
  }
  inspect() {
    return {
      mode: this.mode,
      available: Boolean(this.catalog),
      diagnostic: this.diagnostic,
      storage: this.storeBlocked ? 'blocked' : 'available',
      snapshot: this.snapshot ? structuredClone(this.snapshot) : undefined,
    };
  }
  describe(section = 'status') {
    if (!['status', 'roles', 'workflow', 'coverage', 'events', 'instructions'].includes(section))
      throw new Error('用法：/core [status|roles|workflow|coverage|events|instructions|off|observe]');
    const catalog = this.catalog;
    const header = `涌现内置核心 · ${this.mode === 'off' ? '已关闭观察及规划' : catalog ? '观察模式' : '资产不可用'}\n观察器仅记录执行事实；规划模块按需提供目标与能力约束，不授予权限。/plan 查看任务规划。`;
    if (!catalog) return header + '\n核心诊断：' + (this.diagnostic ?? 'CORE_ASSET_UNAVAILABLE');
    if (section === 'roles')
      return (
        header +
        '\n\n内置治理职责（定义已载入；规划、证据检查与记忆生命周期按需使用，角色名不授予权限）\n' +
        catalog.roles.map((r) => `${r.name} · ${r.id}\n  来源：${r.source}\n  直接执行权限：无`).join('\n\n')
      );
    if (section === 'workflow')
      return (
        header +
        '\n\n八阶段核心循环\n' +
        catalog.stages.map((s) => `${s.name} (${s.id})`).join(' → ') +
        '\n\n十一阶段业务流程及其相关核心阶段（映射关系，并非执行顺序替代）\n' +
        catalog.businessPhases.map((p) => `${p.name} → ${p.relatedStages.join(' / ')}`).join('\n')
      );
    if (section === 'instructions')
      return (
        header +
        '\n\n' +
        instructionLayers.map((l) => l.name + ' · ' + l.authority).join('\n') +
        '\n项目文档、外部资料和模型角色建议都不能扩大运行时权限。'
      );
    if (section === 'coverage')
      return (
        header +
        `\n\n来源：${catalog.source.name} ${catalog.source.version}\n完整源码台账：docs/meta-kim-source-inventory.json\n9 个治理角色、8 个核心阶段、11 个业务阶段：定义已校验\n按需目标规划、能力盘点和绑定检查：已接入（core.planning.enabled 可关闭）\n持久计划执行与人工恢复：已接入\n独立审查/验证与候选记忆批准：已接入，/audit 与 /memory 查看实际状态\n外部记忆/Graphify：未绑定自动同步，使用已配置 MCP 工具需单独授权\n\n外部依赖登记（上游状态不代表本机可用）\n` +
        catalog.dependencies.map((d) => `${d.id}：未接入；上游登记 ${d.upstreamEligibility}`).join('\n')
      );
    const events = this.snapshot?.events ?? [];
    if (section === 'events')
      return (
        header +
        '\n\n最近观察（不含原始提示、回复、参数或路径）\n' +
        (events
          .slice(-30)
          .map(
            (e) =>
              `${e.sequence} · ${e.at} · ${e.kind}${e.legacyDecision ? ` · 现有=${e.legacyDecision} / 影子=${e.shadowDecision} / ${e.comparison}` : ''}`,
          )
          .join('\n') || '暂无记录')
      );
    return (
      header +
      `\n\n策略版本：${catalog.policyVersion}\n来源：Meta_Kim ${catalog.source.version}\n内置资产：${catalog.roles.length} 个治理角色 / ${catalog.stages.length} 个核心阶段 / ${catalog.businessPhases.length} 个业务阶段\n最近观察：${events.length} 条（最多保留 128 条）\n权限对比差异：${events.filter((e) => e.comparison === 'disagreement').length}\n` +
      (this.diagnostic ? `诊断：${this.diagnostic}\n` : '') +
      '\n/core roles 查看角色 · /core workflow 查看流程\n/core events 查看观察 · /core coverage 查看接入范围\n/core off 关闭观察 · /core observe 开启观察'
    );
  }
}
