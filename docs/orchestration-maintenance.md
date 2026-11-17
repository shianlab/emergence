# 编排维护约定

> 历史文档：主控窗口与跨窗口控制已于 2026-11-16 退役。下文解释旧实现，不作为恢复功能的要求。当前维护以 [结构维护入口](structure/README.md)、[职责与状态](structure/phase1/architecture.md) 和 [退役清单](structure/phase1/retirement.md) 为准；共享执行与兼容读取仍须保留。

适用范围：Emergence Harness 的主控规划、任务派发、审查与预算。保留现有 TUI 视觉、单一调度队列和持久化任务 ID。

2026-11-15 规划/存储维护边界：全局工具使用允许集合，作用域工具在各自 when 激活入口检查当前角色；原生限制不影响当前作用域注册，不能假定全局过滤已覆盖所有工具。需求理解完成后再暴露完整工作图 schema，有效方案用原生 concludeTurn 交还既有派发入口。max-tokens 根据本轮原生提交记录识别，禁止将截断当普通提前结束反复续写。JSON 状态文件统一使用 core/storage/safe-json-file.ts，调用方仍保留租约、写队列、schema 和恢复语义；只重试同一次替换，不删目标、不重放业务。代码与剩余真实稳定性边界见 [专项报告](iteration-20261108/r5-planning-report-20261115.md)。

## 职责

| 模块 | 职责 |
| --- | --- |
| `core/domain/task.ts` | 持久化任务结构、状态集合、中文标签及图校验；`needs_review` 表示执行已停止，不能解释为验收成功 |
| `core/application/task-coordinator.ts` | 唯一任务队列、准入事务、执行归属、生命周期和持久化协调 |
| `core/application/task-budgets.ts` | 唯一任务预算轮询、审批依赖计时、到期取消；异步处理仍交由 Collaboration 跟踪，退出时等待收尾 |
| `core/domain/run-budget.ts` | 可注入时间的计时函数、超时原因、公共默认预算；不创建定时器和任务 |
| `core/adapters/planning.ts` | Harness 规划钩子与规划看门狗；计划准入成功后才可执行 |
| `core/domain/work-draft.ts` / `core/application/planning-drafts.ts` | 分步草稿的纯数据规则、串行持久化与原准入桥接；不执行工作任务 |
| `core/application/coordinator-context.ts` | 自动主控模型上下文；展示摘要不改变权威计划、原始约束和权限 |
| `core/application/task-admission.ts` | 原始约束无损传递；总目标留在 GoalContract，局部验收下发到各任务；最终结构预算检查 |
| `core/domain/project-contract.ts` / `core/application/project-contract.ts` | 项目、局部验收、验证规格的版本化结构与真实路径绑定；不新增项目数据库 |
| `core/application/verification.ts` / `tool-evidence.ts` | 采集验证配置基线，经原工具执行入口核对输入版本，生成宿主回执；不是独立执行器 |
| `core/application/inspection.ts` / `execution-evidence.ts` | 按原有 read 权限提供文件字节属性和目录清单，复用宿主证据记录 |
| `core/application/workspace-interactions.ts` | 从原 InteractionQueue 投影全部待办，按窗口、会话、ID/version 和指纹路由响应；不持久化另一份待办 |
| `core/adapters/approval-identity.ts` | 适配当前 Harness 的原生审批日志身份；关联不唯一时拒绝，不猜测 call 或窗口 |
| `core/application/task-allocation.ts` / `work-allocation.ts` | 权限内的目标分配、负载和读写冲突判断 |
| `core/application/audit-allocation.ts` / `assurance.ts` | 独立审查上下文选择、资源预留、证据核对及失败回收 |
| `core/application/team-coordinator.ts` / `team-followthrough.ts` | 总任务登记与持续协调；使用已有队列，不另建调度器 |

## 状态与预算

- 执行、排队、等待审批、暂停分别累计。切换状态先结算上一段时间；整体历时包含暂停和等待。
- 手动跨窗口依赖也传播审批等待；前置任务等待用户时，后续任务不会误扣机器排队预算。拒绝后按依赖失败处理。
- 默认任务执行 10 分钟，排队 10 分钟，审批等待 30 分钟，整体历时 60 分钟；主控规划默认 3 分钟、最多 24 轮。配置和任务契约以各自校验范围为准。
- 总任务默认实际执行 30 分钟、1200 模型步骤、96 次协调动作、12 次修复。容量等待不等于执行成功。
- 中断、失败、副作用未知不得自动重放。审批不可跨会话复用；配置改变不能自动放宽已有任务权限。
- 自动主控默认使用 analyze → plan_step（每次一项）→ plan_commit → 原宿主分配与验收；core.planning.submission=whole 保留整图兼容接口。手动 plan / execute_plan / dispatch 入口不混入自动主控的模型菜单。工具解析和上下文必须预览同一批已领取输入，执行窗口首轮使用任务契约。
- 分步草稿只存入原 PlanStore，不创建第二个任务库或调度器。需求版本和草稿版本同时校验；同一会话串行保存，最多 12 个节点、48 次修改。部分图允许前向依赖，封存必须经过原完整准入。只有成功落盘且封存的图可以派发。
- 草稿保存不等于实施授权。取消、存储失败、未覆盖验收、循环依赖、项目失效均不得启动任务。Plan 模式和拒绝审批保持原行为。
- 输出截断保留已保存的草稿，不自动续写；用户明确说“继续规划”才重开原规划预算并保留需求版本。新目标清除旧草稿，主目录切换也使草稿失效；重启不会自动启动保存的草稿。
- 主控预算事实来自当前模型与会话：输出额度、剩余时间/轮次、单项字数上限。预算反馈不修改供应商参数，不增加原期限，不切模型；不可声称支持关闭供应商强制思考。
- 能力 ID 必须精确匹配实际登记项。错误回执可列出实际同名 ID 帮助模型修订，但不得自动纠错后执行，也不得接受模型自行声明的 ready 状态。

## 项目与验收契约（R2）

- 项目 ID 由规范化真实目录计算，兼容普通文件夹，不依赖窗口编号或 Git。目录迁移视为新身份；junction 目标改变会使旧绑定失效。
- 新跨项目计划使用 localCriteria 引用原始验收编号。全局原文、贡献映射持久化于同一协作状态的 goalContracts；工作代理和独立审查者只承担局部验收。全局文本仍需独立审查判断其局部贡献是否充分，结构映射不能代替语义判断。
- 跨项目读取声明为单独 user-check 步骤的 readProjects，目标必须已经登记，既有 read 禁止规则继续生效。调度器把读取项目纳入冲突范围；范围声明本身不授予权限。
- VerificationSpec 通过普通 pwsh/bash 工具入口执行，精确匹配命令、cwd 和本地验收编号。派发时宿主读取配置基线，执行前后核对输入；审查通过必须引用同项目同规格的有效回执。验证脚本更改要修订计划，不能替换基线来证明旧任务通过。
- 草稿编辑与封存先用原读取策略预检验证脚本的真实路径；派发仍重新采集基线。`verificationRequirements` 为 ledger 和准入共用的验收项映射，拒绝回执给出具体缺口及本会话候选编号，不替模型补写检查结论。
- 只读任务由宿主工具契约推导 `allocation.access`，不由角色名推断；`isReadOnlyTask` 统一用于执行守卫、菜单和独立核验。审查任务继承只读限制。原生只读数据计算可以使用成功进程回执，普通 Shell 不因此获得只读证据资格。
- Shell 仍是原有权限控制的命令执行，不是操作系统文件沙箱；项目路径守卫不能解析任意 Shell 内部访问。模型提出的测试质量仍需独立 reviewer 检查，不因为退出码为零就自动满足业务语义。
- 无规格的任务保留既有通用核验流程；已有持久化记录可读，不回填假基线或伪造项目证据。新契约是可选、带 version 的嵌套字段；既有计划/协作存储版本保持兼容。
- 文件属性观察上限 8 MiB；目录清单仅取直接成员、上限 1000 项，不递归。超限明确失败，不截断后宣称完整。
- `emergence_verify_file` 通过同一原生读取入口执行固定文件断言（字节数、Unicode 码点数、汉字数、UTF-8/BOM、哈希、末尾换行），产生带输入版本的实际检查回执。每次最多 12 项，不执行任意表达式或命令。提交验收及重新检查持久化状态共用 `isSuccessfulExecutionCheck`；普通 `read` / `emergence_inspect` 仍不能充当执行检查，显式 `VerificationSpec` 中的命令要求仍必须由对应命令回执满足。文件断言不证明程序行为或内容语义，独立语义审查继续保留。

## 审批响应（R3）

- `InteractionQueue` 是待办的唯一来源，列表包含各窗口排队中的请求；只有各队列首项可以答复。任务状态用于展示和计时，不用于推测有没有审批。
- 原生工具审批沿用日志中的 approval ID 作为交互 ID；绑定 call、agent/session、原生 turn、task/run、完整参数指纹和权限指纹。宿主决策没有原生 ID 时保留本地请求身份，不伪造原生日志。
- 当前锁定 Harness 的 `approval/request` 不直接携带 approval ID，适配器从该会话当前轮次的已提交 asked/decided 事件中按工具与 callId 唯一关联；不唯一或真实工具调用缺少关联时不能批准。
- TUI、`/approval <ID> <版本> allow|deny|cancel` 和进程内测试调用同一个工作台入口，最终仍由所属控制器检查原队列、权限和执行归属。旧版 `respond(text)` 仅保留为明确请求对象的兼容调用，使用同一生命周期验证。
- `/approvals` 或主控栏“待确认”打开集中列表，选择只显示所属窗口；用户继续在原审批控件操作。没有批量允许，也不根据窗口焦点解释响应身份。
- 权限变更、窗口关闭、原生决定、轮次结束、代理释放会撤销相应待办；重启不恢复旧授权。拒绝/取消保留原生不同终态，同一轮完整指纹相同的操作不再反复申请；用户新输入开启新轮次后仍可重新决定。
- 原生元数据工具声明宿主 `read` 策略别名，read 的 deny/ask 与自身工具规则取交集；ask 经过正常审批，读取期间再次检查权限版本。不使用 Shell 字符串例外。
- R3 定向回归：`npm run test:approvals`、`npm run test:approvals:tui`。后者使用原生渲染器注入键鼠事件；真实终端传输另外运行 `tests/tui-phase4-terminal.ts`。不能把这些可控模型结果当作付费模型矩阵验收。

## 2026-11-16 产品范围收缩

用户决定舍弃主控和跨窗口协同。正式 `WorkspaceController.executionScope` 固定为 `session`，不是用户配置开关。窗口控制命令、模型可见派活工具、角色菜单和跨窗审查入口已退出产品；准入同时拒绝跨窗任务、跨窗计划和隐式审查开窗。单窗口规划、权限和原生子代理保持原有实现。

旧工作台/SQLite 台账保留任务、会话和草稿事实，恢复时清除主控/执行/接管关系，未结束任务不重放；模板忽略旧角色。`tests/fixtures/historical-orchestration.ts` 是历史任务引擎的测试专用宿主，用于继续验证旧契约、权限和证据，不进入产品构建，也不代表协同功能仍可启用。正式产品验收使用 `tests/independent-windows.test.ts` 和 `tests/tui-independent-windows.ts`。下方协作阶段说明作为历史维护记录保留，不是当前使用入口。

## 开发检查

澄清答复衔接修复（2026-11-16）：

- 原生 `user-questions/request` 仅在真实交互队列全部回答后，将答案接纳为等待中目标的补充用户来源。绑定原计划对象，排除审批意图、已派发任务、受托任务和已停止轮次；取消、迟到或错误会话的答案不能解除待答状态。
- 补充答复继承原始要求、协调目标、读取回执和规划计时，清除待修订的分析/草稿并允许重新理解；不会自动修改需求约束、重置预算或授予权限。普通工具结果不能走这条用户输入入口。
- `继续规划` 仅恢复已经完成澄清的草稿；仍有待答问题时走正常用户补充流程，避免锁在旧分析上。专项入口为 `tests/planning-clarification.test.ts`；付费模型与真实终端复验为 `tests/planning-clarification-live.ts --live`，全部尝试需保留。

第二、三阶段联合巡检（2026-11-15）：

- 主控设置、取消及 `/collab` 配置统一由 `Collaboration.assertConfiguration` 检查，工作台在切换默认模型前预检，核心在提交时复核。历史 `blocked` / `interrupted` / `needs_review` 不当作仍在运行；若总目标仍在自动审查/修复或主控仍有运行/审批，则继续保护归属。同主控新增执行窗口仍允许。
- `TaskExecution` 的异步依赖观察不写任务结论。观察完成及投递前核对当前任务、状态、取消、停止、会话/项目/模型与租约；迟到结果不能向失去归属的窗口注入工作。取消由原取消流程收尾，退出由原关闭流程收尾。
- 轮次结算先收集结果和文件版本，复核归属后一起提交；已经终结的任务不能被迟到回调改写成另一份结果。`finishWithoutTurn` 对已终结任务幂等。
- 新回归：`tests/dispatch-lifetime.test.ts`、`tests/team-reconfiguration.test.ts`。专项含跨项目取消/接管/读取失败、取消期间结算、历史任务切换主控、活跃总目标和审批保护。完整结果见 [联合巡检报告](iteration-20261108/phase23-review-20261115.md)。

R5 巡检边界（2026-11-15）：

- `planning-tools.ts` 的 `coordinatorToolAllowed` 同时用于主控工具菜单与实际执行守卫。不能以 permission=read 将任意元数据工具当作可用的主控控制工具；独立会话释放主控菜单限制。
- `safe-json-file.ts` 对 Windows 原子 rename 的 EPERM/EACCES/EBUSY 仅重试同一临时文件替换，最多额外四次、累计等待 300 ms；每次复核目标，不删除目标或重放业务。持续占用明确失败并保留旧快照。
- 计时文件读取失败继续保护原文件；暂时写失败保留内存与提示，后续采样和最终保存可恢复。诊断不是执行事实存储；真实验收不能把仍为 running 的退出后快照当成完整统计。
- 真实验收器按物理项目身份与所属任务工作目录解释路径，Windows 大小写不应造成误判；仅允许明确的 fixture 项目，仍保留越界负例。规划前失败不得笼统归为聚合失败。
- R5 后续分步规划与响应校验修复后，最终同一构建 367/367 本地回归及 12/12 真实矩阵通过；此前失败保留，原关闭标准中的用户真实项目试用确认仍待完成。当前结果见 [最终验收报告](iteration-20261108/r5-drafts-report-20261115.md)，早期失败见 [历史 R5 报告](iteration-20261108/r5-report-20261115.md)。不能依据单一矩阵宣布所有项目或外部服务均稳定。

R4 恢复边界（2026-11-14）：

- 请求重试只由既有 dsh-llm-retry 执行；配置统一来自 modelProviders，normal 模式最多额外两次，不重放整个业务任务，也不叠加 HTTP 层重试。退避属于原模型等待时长，原取消信号及各类期限持续生效。
- `MALFORMED_RESPONSE` 与传输/服务器错误走同一有限请求恢复；适配器拒绝的整个响应尚未提交，任何工具块都不能执行。此前轮次已返回的写入不会重放，持续格式错误在原上限内失败。凭据错误和超时不自动加入重试范围。
- `core/adapters/model-response.ts` 使用本次公开工具 Schema 在成功响应提交前校验参数。模型缺字段/类型错误通过公开 finish/error 协议进入原请求恢复，不能先让空命令进入审批；取消、截断、usage 与 replay metadata 不改写。工具本体仍保留最终参数校验，未知工具仍由原可见性门禁决定，手工非 Agent 模型调用不受此拦截。
- 任务失败统一由 task-failures 归并；result.failures 保留失败 call ID 与替代证据，errors 仅为旧界面的未解决错误投影。验收使用 unresolvedTaskErrors 并复核替代回执当前版本，不能手动清空 errors 换取成功。
- 只读恢复只接受相同工具、同 task/run/session 的后续证据；普通失败保持参数相同。纠正参数须同时有本机原生 schema 校验失败和 INVALID_ARGS 回执，不靠错误文案推断；命令、写入和未知工具不得套用此规则。
- 源码未修改时，真实测试失败不能由偶发绿色覆盖；修复前后必须保持测试口径。Shell 或进程中断的未知副作用继续走原显式核对流程。
- R3 的同轮拒绝阻断保留于独立会话；派发任务中拒绝/取消原生工具审批会停止所属任务及其协调目标，不再继续请求模型改参数。宿主确认与工具审批仍按原身份区分。
- 复验入口为 `test:recovery`、构建后的 `test:recovery:http`、`test:approvals:tui`。具体行为与未覆盖的真实供应商验收见 [R4 报告](iteration-20261108/r4-report-20261114.md)。

在 `emergence` 目录、项目指定的 Node 版本下运行：

```text
npm run check
npm run format:orchestration
npm test
npm run inspect:full
npm run inspect:security
```

`check` 包含 TypeScript 严格检查、全自有 TypeScript 格式及 `check-architecture.ts` 的依赖/任务写入边界检查，不声称提供完整 ESLint 或安全证明。Prettier 固定版本，覆盖清单由 `scripts/source-files.ts` 生成，排除受独立哈希校验的生成文件；修复时只格式化实际修改的文件，避免产生无关变更。配置依据 [Prettier 官方安装说明](https://prettier.io/docs/install)。

涉及预算时运行 `tests/scheduler-budgets.test.ts`；涉及准入、审查时运行对应的 admission、assurance、master 测试。完整验收应冻结源码、保留哈希和失败记录；真实模型结果与确定性测试分别汇报。没有明确运行证据，不能将派发、模型自报或工具存在视为任务成功。

安全回归继续覆盖权限交集、路径/junction/ADS、审查独立性、配置会话令牌、日志脱敏、MCP/Skills 门禁和 Data 只读边界。新增能力不得为提高通过率而自动批准任意 Shell、关闭权限检查或全局禁用外部 Skills。
