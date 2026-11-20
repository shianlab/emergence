# Emergence 当前结构维护入口

本页说明当前产品的结构约束。历史阶段方案只用于追溯，不授权恢复已取消的功能。

当前产品是独立多窗口 CLI Agent。各窗口独立使用项目、模型与会话；保留 KIM、原生子代理、Code/Data、Skills、MCP、记忆及审批。主控窗口、跨窗口派活与跨窗口控制已经退役。

## 维护依据

- [七阶段结构整理方案](../structure-refactor-plan-2026-11-16.md)：实施顺序与完成条件。
- [第一阶段基线](phase1/baseline.md)：源码、分支、证据适用范围。
- [职责、状态与依赖](phase1/architecture.md)：当前归属和第二阶段需要修正的边界。
- [退役与兼容清单](phase1/retirement.md)：逐项决定保留、提取或删除，禁止按文件名批量删除。
- [行为验收清单](phase1/acceptance.md)：必须保留的产品行为及验证入口。
- [第一阶段结果](phase1/report.md)：已完成工作和尚未实施的结构调整。
- [第二阶段结果](phase2-report.md)：能力契约、基础文件职责迁移与依赖检查。
- [第三阶段结果](phase3-report.md)：退役协同退出、TaskEngine、历史兼容与完整验收。
- [第三阶段迁移清单](phase3-migration-catalog.json)：文件及测试的变更、删除和保留职责覆盖。
- [第四阶段结果](phase4-report.md)：会话与规划职责迁移、竞态修正及完整验收。
- [第四阶段迁移清单](phase4-migration-catalog.json)：实现、调用方和测试的变更前后哈希及归属。
- [会话与规划维护指南](session-planning.md)：当前状态写入入口、资源收尾顺序和异步绑定约束。
- [第五阶段结果](phase5-report.md)：TUI 职责迁移、原生编辑/连接边界与完整验收。
- [第五阶段迁移清单](phase5-migration-catalog.json)：17 个实现、构建和测试文件的前后哈希及归属。
- [界面维护指南](ui-maintenance.md)：窗口/输入/模态状态、原生草稿和连接生命周期、C# 构建规则。
- [第三阶段审查修复记录](remediation-phase3-report.md)记录工作台空闲帧、XLSX 预算和兼容性验收。
- [第四阶段候选验收记录](remediation-phase4-report.md)记录签名、下载、安装、迁移和回退的检查结果。
- [第六阶段结果](phase6-report.md)：四种语言规范、隔离工具、CI 与完整验收。
- [第六阶段迁移清单](phase6-migration-catalog.json)：排版/代码整理批次、检查入口与新增输入范围。
- [编码规范与检查入口](coding-standards.md)：固定工具、明确排除、日常命令和审查规则。
- [安装与发行维护边界](installation-maintenance.md)：下载、部署、启动检查、缓存和安装专项测试归属。
- [版本发现与在线更新维护](update-maintenance.md)：签名、缓存、更新服务、菜单及发布输入归属。
- [安装第三阶段结果](../installation-phase3-report-2026-11-17.md)：中文更新提醒、签名下载、在线安装与隔离验收。
- [安装第四阶段结果](../installation-phase4-report-2026-11-17.md)：1.02 本机发行候选、旧版实包迁移和外部验收边界。
- [安装第二阶段结果](../installation-phase2-report-2026-11-17.md)：统一升级/修复/回退、崩溃恢复、运行版本保护和真实迁移验收。
- [第七阶段结果](phase7-report.md)：结构复审、性能修正、最终矩阵及候选验证；用户已确认原生界面正常使用。
- [1.0.1-rc.1 候选说明](../releases/1.0.1-rc.1.md)：本地候选的变化、数据兼容与试用边界。

## 当前约束

1. Harness 拥有 Agent 会话历史和工具执行循环；Emergence 接入它，不建立并行的第二套执行循环。
2. TaskLifecycle 是任务状态变更入口，ExecutionJournal 保存任务与副作用事实；工作台 JSON 不能覆盖更新的台账。
3. 每个 SessionController 的 InteractionQueue 拥有本会话交互，批准必须核对请求身份与有效期；焦点和布局不授予权限。
4. KIM 需求/规划状态与执行台账分别管理。计划存在、文件存在和模型声明成功都不能代替执行及验收回执。
5. Code/Data 拥有各自专业状态，通过明确的宿主契约接入 Harness；界面读取结果和投影。能力不得反向引用 app/Controller，核心通过 CodeEvidencePort 消费代码证据，不依赖具体能力类。
6. 拒绝、取消、超时、崩溃后的未知副作用不自动重放；恢复旧数据不得重新激活跨窗口控制。
7. 模型配置使用原生 Windows Forms，配置与凭据沿用既有串行更新、版本冲突检查和 DPAPI。
8. 当前由 TaskEngine 接纳本会话计划；旧协调器、主控草稿及跨窗审查入口已经退出。历史工作台字段 `collaboration` 仅是存储兼容名称，旧元数据保存在 task state 的 `history` 中，不授予执行权。
9. 后续模块接管职责时，调用方迁移、旧实现退出和回归验证必须一起完成。第一阶段表格是冻结基线，现状以第二至第六阶段迁移报告及第七阶段复审为准。
10. SessionLifecycle 统一会话句柄、切换和关闭，SessionPermissions 统一授权；PlanningRequests 是需求与规划状态写入入口。外部只读分离快照，异步结果必须核对原请求及目录范围。各模块不能重新维护第二份权威状态。
11. 工作台挂载拥有视图注册表、唯一模态状态和全局 UI 资源收尾；输入路由、窗口创建、提示及品牌投影按明确接口接入。原生工具由 ModelDraft 隔离编辑数据、Connection 管理连接与自有进程；迟到响应不得更新已关闭窗口。新增 C# 文件必须继续纳入发现、指纹和编译链。
12. 自有 TS/C#/Python/PowerShell 使用固定版本的开发检查工具，检查只读、格式与行为修正分开。新代码自动进入维护目录的发现范围；生成资产排除必须有来源和校验依据。开发工具只存在隔离目录，不增加用户运行依赖。

新增检查沿用现有入口：`npm run check`、`npm test`、`npm run inspect:full`。静态架构清单由 `emergence/scripts/inspect-architecture.ts` 生成；清单记录事实，不把已发现的技术债视为规则豁免。
