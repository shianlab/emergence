# 第三阶段：剥离退役协同，保留单会话执行

日期：2026-11-17。对应七阶段方案第三阶段；基线为第二阶段冻结源码。当前产品继续提供独立多窗口，不恢复主控、跨窗口派活、自动扩窗和跨窗审查。

## 职责迁移结果

| 原职责 | 当前归属、调用和退出结果 |
| --- | --- |
| Collaboration / task-coordinator 同时管理任务与窗口控制 | `TaskEngine` 拥有本窗口计划准入、提交去重和任务操作；Workspace、规划回调、工具、TUI 与测试统一使用 `taskEngine`。旧文件及类名退出，没有转导出壳或第二套队列 |
| TeamCoordinator、TeamFollowthrough 与自动分配 | 删除构造、工具注册、模型回调、调度、时钟与收尾调用。保留现有 TaskScheduler、TaskBudgetMonitor、TaskExecution、TaskLifecycle、ExecutionJournal；资源冲突与排队公平性仍在同一引擎中判断 |
| 主控能力清单与工具限制 | 每个 CorePlanning 只投影本会话的项目、模型、能力与权限。Code/Data 接入不再接收主控角色、协调状态或主控工具可见性回调 |
| 主控草稿、自动派发与审查分配 | 删除 planning-drafts、work-allocation、audit-allocation、coordinator-context 及相关工具。普通 KIM 分析、需求来源、澄清、规划、真实执行与受限修复继续运行 |
| 独立审查创建与证据核对混合 | 删除跨窗审查请求、审查提交和运行上下文入口。CoreAssurance 保留宿主证据采集、产物/来源版本、历史核对、记忆准入和只读证明；当前 `emergence_receipts` 查询本会话正在执行任务的实际回执 |
| 旧团队 UI | 删除 team-bar/team-feedback 的构造、依赖、事件与源码。任务详情、审批入口、独立窗口切换/关闭继续存在；移除输入提示中的 `/takeover` 和数据能力中的跨窗复核说明 |
| 旧验收宿主 | 删除 `historical-orchestration`，共享测试直接使用实际 WorkspaceController/TaskEngine。没有只给测试开放的主控开关或空协调器 |

任务状态仍只经 TaskLifecycle 更新，任务与副作用事实仍由 ExecutionJournal 保存。Harness 继续拥有消息、工具和执行循环。本次没有引入第二套执行器或复制状态。

## 历史与配置兼容

- `domain/task-state.ts` 定义当前 v2 任务状态；旧 master/workers/coordinations 等只在 `history` 中保存。`storage/task-history.ts` 将 v1 解码为 v2，并复用同一套身份、依赖、修复/恢复引用和循环校验。
- `legacy-coordination.ts`、`legacy-work-draft.ts` 只保留读取旧数据所需的契约。历史目标查询可以沿修复/恢复/审查引用找到原目标，但不会构造调度器。
- 旧未结束任务恢复为中断，保留副作用已返回/未知事实；调度、直接启动、恢复与派生修复入口都不能重新执行旧跨窗或审查任务。
- 工作台 JSON 的历史字段名 `collaboration` 仍保持，内部值写为 v2；这是存储协议兼容，不是第二个运行对象。SQLite 仍优先于可能过期的工作台 JSON。
- 旧模板角色、旧模型角色默认项和旧规划协调字段仍可作为原格式数据读取，当前路径不据此分配窗口或执行任务。模型库、密钥、布局和草稿保持原存储。后续第四阶段整理规划存储职责，不重启这些字段对应的行为。
- 工具权限名称迁移补充兼容别名：旧 `emergence_dispatch` 的禁止/询问规则继续约束当前 `emergence_execute_plan`，避免更名使旧限制失效。
- 已退役的工具名不再享有宿主只读/控制工具的默认信任；同名外部工具按未知操作走正常权限检查。最终复审移除了旧审查任务的报告、自动通过和权限继承分支，当前受契约约束的任务完成后仍进入待验收。
- 没有读取个人密钥文件，没有清空数据库、会话或用户配置，没有更新依赖版本、发布版本或 1.00 标签。

## 测试迁移与删除依据

文件及测试标题逐项记录在 [迁移清单](phase3-migration-catalog.json)。该清单相对第二阶段冻结文件生成，包含变更前后哈希；静态标题数不等于运行时测试数。共享职责覆盖与旧功能退役分别记录，不用新的单窗口测试声称跨窗功能仍存在。

| 原测试/职责 | 现有验证入口与处置 |
| --- | --- |
| 自动主控派发、跟进、窗口匹配、接管与自动审查 | master-dispatch、master-followthrough、team-reconfiguration、planning-drafts、collaboration 和团队界面场景退出；当前产品没有这些行为 |
| 准入、权限变更竞态、模型/目录绑定、重复提交与原子存储 | dispatch-admission、task-admission、core-planning、requirements、planning-clarification 改用实际本会话执行；保留拒绝、过期、取消和失败断言 |
| 排队、预算、资源冲突、恢复及未知副作用 | core-execution、orchestration、scheduler-budgets、task-failures、workspace-approvals、architecture-baseline；三段依赖/审批等待在同一会话任务图验证，多个独立会话继续验证冲突和取消隔离 |
| Code/Data/KIM 串联 | code-data-integration 验证实际工具失败、修复、再次执行检查、用户验收后依赖释放，以及真实数据交付；不再调用跨窗审查宿主 |
| 真实回执、检查与记忆 | inspection、verification、run-manifest、task-failures、core-memory、core-acceptance 等保留；core-assurance 中仅为自动创建审查任务的路径退出，原生文件字节检查保留 |
| 历史审查有效性 | task-history 新增真实文件读取回执；正例通过后，逐项验证错误 run/session/task、缺失 manifest、伪造编号、拒绝项、失败回执、真实执行错误与文件变更均不能通过证明 |
| 历史数据及退役边界 | task-history 验证 v1/v2 往返、损坏依赖拒收、历史目标查询、直接启动/恢复拒绝；independent-windows 验证旧工作台/台账/模板读取且不恢复主控 |
| 旧阶段命令与脚本 | 退出 23 个被当前完整矩阵替代的历史巡检包装脚本，以及引用已删除主控用例的 phase3e-live 旧矩阵；它保留的单会话测试入口仍在。移除 package 中失效的历史/主控命令。旧阶段报告保留追溯，当前巡检入口统一为 inspect-full、inspect-security、inspect-architecture |

第一次完整单元复测为 296/308，通过迁移修正了旧测试仍操作原主窗口权限、读取旧状态字段等问题。后续定向复测发现旧权限名称需要兼容别名，并完成修正。新增历史测试编写时修正了夹具的角色字段和 JSON 对可选 undefined 字段的序列化预期。上述失败日志保留，不隐藏失败，也没有增加跳过或放宽超时阈值。

第一轮矩阵曾达到 41/41、313 项单元测试通过。最终复审继续删除残留审查分支并增加退役工具权限测试后，第二轮出现 1 项旧夹具失败：库存分页测试使用了已退役工具的控制权限样本。改为当前 `emergence_plan` 后保留原有全部分页、事实完整性和不修改输入的断言；第二轮提前停止，最终验收重新运行完整固定版本矩阵，不把中间轮次拼接成最终通过。

清理验收入口时还发现旧包装脚本引用已删除的测试/路径，第三轮因此主动停止，完成入口清理后重新冻结。最终证据只采用 `accepted/inspection.json`；中间轮次的日志保留用于解释修复过程。字面路径扫描剩余的 `tests/revenue.test.ts`、`tests/calc.test.ts` 是 Code 能力测试在临时项目中创建的文件名，不是缺失的验收入口。

## 结构复审

| 指标 | 第二阶段 | 第三阶段 |
| --- | ---: | ---: |
| 自有 TS/Python 源文件 | 164 | 157 |
| 源文件行数（含空行） | 28,165 | 24,833 |
| 运行值导入循环 | 0 | 0 |
| core 反向依赖 app | 0 | 0 |
| app 内部类型耦合组 | 8 个模块 | 8 个模块 |
| core 内部类型耦合组 | 20 个模块 | 15 个模块 |

当前架构检查还明确禁止导入已退役的主控、持续协调、分配、草稿和团队界面模块，没有新增白名单或全局忽略。行数减少不是质量证明；本次依据是职责/调用/状态/收尾成套迁移及对应回归。

会话控制器和规划服务仍需要第四阶段继续拆分，TUI 内部结构与多语言规范分别在第五、六阶段处理。本阶段不声称全仓库已经没有结构债务。

## 验收记录

第三阶段已完成。最终版本使用固定 Node 26.13.0，在 `accepted/inspection.json` 记录的同一版本上完成以下验收：

- 完整矩阵 **41/41** 通过；单元与 Harness 集成 **314/314** 通过，失败、取消和跳过均为 0。
- 严格类型检查、318 个自有 TypeScript 文件的格式检查、154 个 TS 源文件的架构检查及 CLI/Harness/原生配置工具后台构建通过。
- 本地模型配置路由与凭据轮换、Skills/MCP、HTTP 重试与取消、故障恢复、16 会话并发及释放通过。
- 18 项 OpenTUI/UI 自动脚本和 13 项后台真实终端脚本通过，包括 Windows PowerShell 5.1、PowerShell 7 和 cmd 场景。
- 固定版本验收期间文件变化为 0，package 与 lock 对齐；验收后逐文件重新核对源码和检查输入哈希一致。`git diff --check` 通过。
- 退役协调器的生产声明与导入均为 0，未增加运行值导入循环。单元数量由第二阶段的 400 项变为 314 项，旧功能退出、共享测试迁移及新增边界测试的去向见上表和迁移清单；不能把两个阶段的测试总数直接当作覆盖率比较。

源码指纹：`1432eb275a0f8bc920e95ffe2f0efbddf61737ea462997c64c64f94241dee81a`。检查输入指纹：`ac8b79e6fccb1b4f9378f0b6eefbbfebc2e87dba02e4b26c97aa9213376a5c4e`。

原始证据位于 `artifacts/structure-phase3-20261117/`：`accepted/inspection.json`、`phase-verification.json`、`architecture-before.json`、`architecture.json`、`migration-catalog.json` 及中间失败日志。最终验收后只补充维护文档，没有再修改受测实现、测试或检查脚本。

按用户要求，本阶段不控制桌面、鼠标或应用窗口。后台 OpenTUI 测试渲染器和 ConPTY 终端脚本属于自动测试；原生配置工具只后台构建和协议验收，不把它描述为人工点击验收。未调用付费在线模型，未执行安装或 GitHub 发布。

下一阶段按原方案整理 SessionController 与 CorePlanning 的职责、状态操作和资源收尾；本次不提前实施第四阶段。
