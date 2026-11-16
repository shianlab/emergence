# 第一阶段：迁移、兼容与验收清单

状态更新（2026-11-12）：第二阶段 M01–M08 已实施并完成本地回归，见 [第二阶段报告](phase2-report.md)。以下表格保留原定迁移依据；第三阶段真实模型/结构化协议验收仍待推进。每批必须迁移全部内部调用者、删除被替代实现、补齐必要行为回归并更新文档。

## 1. 第二阶段执行批次

| ID / 顺序 | 当前实现 → 目标负责人 | 消费者及迁移动作 | 旧路径退出 / 验收依据 |
| --- | --- | --- | --- |
| M01 契约 | app/permissions、orchestration、task-state → core/domain 契约；主机路径另放 adapter | config/controller/collaboration、planning、assurance、allocation、memory、tests 统一引用新定义 | 原 schema 不留副本；permissions/orchestration/task-admission/team-foundation 测试；纯领域无 app/Node IO 依赖 |
| M02 安全基础 | safeError/credentialNames → redaction adapter；lease → storage；JSON 公共原语 → safe-json-file | domain/memory 改为纯规则 + 应用层敏感检测；config、memory、journal、所有 Store 迁移 | 保留凭据轮换即时脱敏、路径/junction/ADS、损坏拒绝、原子写与锁；audit-security/credentials/core-memory/core-planning/core-execution |
| M03 生命周期 | Collaboration 的任务状态转换、checkpoint 与准入 → TaskLifecycle | budgets、assurance、followthrough、settings、workspace 以用例更新状态；UI 读取快照 | 消除外部 mutable task 写入；合法转换集中；task-admission/scheduler-budgets/architecture-baseline；持久化失败不能启动工具 |
| M04 调度与执行 | Collaboration.pump/start/finish/settled → TaskScheduler + HarnessTaskExecution | Workspace/Team/Planning 调同一 TaskDispatch 端口；注册和销毁由组合入口持有 | 只有一个 pump/active ownership；旧事件监听清除；collaboration/core-execution/workspace/isolation；重复事件不重复执行 |
| M05 证据与恢复 | Collaboration 的 receipts/review/recover + CoreAssurance → 现有 evidence/assurance + TaskRecovery | 通过 TaskAccess/ExecutionStore 接口替代整个 Collaboration | Journal 不重复、effects 不丢；取消后晚到结果不得改变终态；core-assurance/core-execution/master-followthrough |
| M06 规划与团队 | CorePlanning → PlanningService + Harness planning adapter；TeamCoordinator/Followthrough 迁入 application 并缩小依赖 | Workspace 与 --print 都注入 Session/WindowInventory；保留唯一 intake/plan/run 路径 | 清除 core 对 app 控制器导入；无第二份 KIM 状态；runtime-intake/core-planning/master-dispatch/master-followthrough |
| M07 展示与命令 | workspace-ui/workspace/settings 的命令分支 → 命令描述注册 + 应用用例 | 鼠标菜单、快捷键、斜杠命令统一调用；TUI 仅管理编辑/显示 | 保留首页/对话、主控标识和原生配置；message-model/interactions/pane-close/model-config-lifecycle，必要 TUI 无头与终端回归 |
| M08 清理与规则 | 旧导出、历史未引用原型与重复文档 → 清理登记 | 搜索运行入口、脚本、测试及构建引用后判断，不能按名称删除 | 目标 23 条反向依赖逐项关闭；format/lint/边界检查纳入工程；保留必要 probes、vendor、品牌母版 |

每批在实现前记录所改输入文件 hash；完成后检查是否有其他工作改变共享文件。提交应区分移动/格式化与行为修改，回退同时考虑数据版本。最终 `app/collaboration.ts` 可暂为薄装配入口；原队列/规则必须退出，不能“旧类仍执行，新类只包一层”。

## 2. 23 条反向依赖的逐组销项

| 当前消费者 | app 来源与数量 | 批次 / 替代 |
| --- | --- | --- |
| core/domain/team | permissions ×1（运行） | M01 纯权限契约 |
| core/domain/memory | config ×1（运行） | M02：纯内容规则留领域；运行环境凭据检测移应用/adapter |
| core/storage/execution-journal、memory-store | lease ×2（运行） | M02 storage lease |
| core/adapters/harness | controller ×1（类型） | M06 SessionObservation 端口 |
| core/adapters/memory | controller ×1（类型）、permissions/config ×2（运行） | M01/M02/M06 |
| core/adapters/planning | controller ×1（类型）、orchestration/permissions/config ×3（运行） | M01/M02/M06 |
| core/application/assurance | collaboration ×1（类型）、permissions/orchestration ×2（运行） | M01/M05 TaskAccess + Evidence 接口 |
| core/application/audit-allocation | task-state ×1（运行）、workspace/collaboration ×2（类型） | M01/M03/M05 窗口及任务端口 |
| core/application/task-admission | orchestration ×1（运行）、collaboration ×1（类型） | M01/M03 |
| core/application/task-allocation | permissions ×1（运行）、collaboration ×1（类型） | M01/M03/M04 |
| core/application/work-allocation | permissions ×1（运行） | M01 |

总计运行 15、类型 8。此表保留第一阶段的债务基线；第二阶段静态检查已确认 23 条全部退出，当前反向导入为 0。

## 3. 兼容与数据迁移决定

| 对外/持久化边界 | 本轮决定 | 迁移与回退要求 |
| --- | --- | --- |
| CLI emergence、--home、--print、--resume 及当前斜杠命令 | 保持兼容 | 命令解析改为统一用例，参数含义不静默改变；高级手动派工入口保留 |
| config.json version 1、模型 ID/env 引用、窗口默认分配 | 第二阶段不改格式 | 保留现有 migrateConfig 备份行为和未知版本拒绝；新增字段/版本另作显式迁移 |
| 工作台 JSON version 1 与 collaboration 快照 | 暂保留读取/写入格式，SQLite 优先规则不变 | 不删历史工作台；移除冗余快照需版本迁移和旧版本回退说明 |
| SQLite user_version 1 与 effects/fence | 保持格式、事务与租约语义 | 迁移前用 SQLite 支持的备份/关闭后复制策略，不能只拷贝活跃主库漏 WAL；不自动降低版本 |
| PlanStore / MemoryStore / CodeWorkflow / Data definition 与 manifest | 保留 v1 schema、容量、scope 和证据版本 | 损坏/未知版本失败保留原文件；缺文件与损坏分开；不在通用存储层自动创建“成功空状态” |
| Harness 会话事件与持久化 | 继续使用上游服务 | 不自行重写上游 session；依赖升级另验收；临时审批不持久重放 |
| ExtensionAPI、MCP、外部 Skills | 保留当前接口与启停 | 扩展模块受信任；展示能力不等于隔离；不全局禁用 Skills |
| emergence_plan_work(work_json)、emergence_plan(plan_json)、emergence_assess(checks_json) | 第二阶段保持；第三阶段改结构化协议 | 先确认实际工具定义和模型适配支持；旧字段仅由入口转换到唯一 schema，两种形式冲突明确拒绝；内置调用者与测试迁完后移除兼容，外部调用者需记录弃用版本 |
| app 文件直接 import 的内部接口 | 允许迁移，不承诺稳定 SDK | 更新所有自有调用者与测试；不得凭空承诺内部源码路径是公共插件 API |
| credentials DPAPI 与用户资料 | 不迁出用户目录、不进入 Git | 不复制作者凭据作为默认配置；备份/回退不得输出明文 |

本阶段未改变任何用户持久化格式。许可证最终选择、公开发布、安装分发模式属于第五/六阶段。

## 4. 回归基线与第三阶段测试任务

| 不变量 / 场景 | 现有测试证据 | 后续验收要求 |
| --- | --- | --- |
| SQLite 权威、旧 JSON 不可虚报完成 | 新增 architecture-baseline.test.ts；core-execution legacy、fence、crash 用例 | 每次改状态/存储必须复测；保留草稿与暂停状态 |
| 准入必须先持久化、约束完整传递 | task-admission.test.ts | 12 步、持久化暂停/失败、范围预算、全局验收完整 |
| 同项目互斥、多项目路由、读写公平性 | scheduler-budgets、workspace、master-followthrough | 无重复派发；排队不能抢过较早写任务；真实模型第三阶段单列 |
| 分开计算审批/排队/执行预算 | scheduler-budgets.test.ts | 包括静默模型 watchdog、依赖传播、总预算；不扩大常量凑通过 |
| KIM 每次输入准入、简单路径、主控自动派工 | runtime-intake/core-planning/master-dispatch | 模拟模型之外补真实任务；不靠用户追加“请派工”才完成 |
| 角色权限与审查证据 | permissions/core-assurance/master-followthrough | 角色工具菜单生命周期、真实失败不能抹掉、文件变化后证据失效 |
| 取消/重启/不确定副作用 | core-execution/master-followthrough/isolation | 不能重复写入、复活取消图、重用旧授权 |
| 原生配置并发/关闭、凭据脱敏 | model-config-lifecycle/model-configuration/credentials/audit-security | 第四阶段实际操作；第五阶段新用户环境；不以模拟 GUI 代替真机 |
| Code/Data/记忆/MCP | code-workflow/data-analysis/core-memory/core-resilience 等 | 本阶段回归；专门能力改进第四阶段，安装资源第五阶段 |

真实验收至少覆盖单窗口 Code、同项目主控多窗口、跨项目隔离三类任务，各至少两轮。执行前固定样本、模型组合、次数和预算；保留失败及修复后重跑记录。当前阶段不发起付费 API 请求。

## 5. 问题台账与归属

| ID | 状态/证据 | 责任阶段及关闭条件 |
| --- | --- | --- |
| B01 | 已确认：23 条反向依赖、职责集中、多个合作组件持有可变任务 | 2：按 M01–M08 完成目标结构和退出检查 |
| B02 | 已确认：三个计划/审查入口仍收 JSON 字符串 | 3：同源 schema、结构化错误、适配兼容及真实任务验收 |
| B03 | 未完成验证：历史最终审查菜单修复后缺最终 live-team 报告 | 3：当前构建完整闭环报告；禁止引用旧尝试宣告通过 |
| B04 | 已确认：Python worker/analytics 等发行资源未进入当前包 | 5：移走源码/参考目录后的干净安装验证 |
| B05 | 已确认：格式检查只覆盖 24 个文件，无全面架构规则 | 2：分模块规范检查，生成文件/vendor 有明确例外 |
| B06 | 已确认：公开目录规则缺本机环境与原始记录边界 | 1 已处理忽略规则、候选审查及本地基线；6 发布前再次审计 |
| B07 | 已确认：历史文档混合旧模式、作者本机路径 | 1 已脱敏个人下载路径；4/6 统一当前用户文档与包内链接 |
| B08 | 已确认：自有许可证未选、发行上游 notice 未齐、无 CI | 6（打包资源属5）：来源核对、作者选许可、实际发行清单与 CI |
| B09 | 已确认：doctor 缺完整数据环境/Git 状态解释 | 4/5：准确诊断与新用户操作验收 |
| B10 | 边界：宿主 JS 扩展受信任；Python 版本固定但未统一哈希审计 | 5/6：文档公开信任范围，补依赖与安装校验；不误称沙箱 |

安全/构建/基线报告见 [第一阶段报告](phase1-report.md)。阶段完成意味着设计与基线可用，不代表 B01–B10 已全部修复。
