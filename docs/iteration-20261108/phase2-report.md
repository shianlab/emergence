# 第二阶段完成报告：架构边界与职责收口

完成日期：2026-11-12。对应第一阶段确定的 M01–M08。结论：本轮架构整理与本地回归完成，可以推进第三阶段的模型协议与派工可靠性验收。这里的完成不代表开源发布、真实模型和新机器安装已验收。

## 已完成的结构调整

| 批次 | 结果 |
| --- | --- |
| M01 契约 | 权限、任务、编排、配置、指引及 UI 偏好契约迁入 core/domain；路径规范化留在 adapter。领域不读取环境或文件。 |
| M02 安全基础 | 脱敏独立到 adapter，租约归 storage；配置、计划、观测、记忆、Code 工作记录、Data 口径复用 safe-json-file。保留各自 schema、锁、目录校验和恢复政策。SQLite、备份及追加归档继续使用专用语义。 |
| M03 生命周期 | TaskLifecycle 持有任务图、恢复加载与 checkpoint；状态转换有显式规则，TaskRecord 顶层只读。状态、回执、计时、执行记录和审查结果通过生命周期接口更新。准入编排继续由同一个 Collaboration 用例协调，持久化失败仍阻止执行。 |
| M04 调度执行 | TaskScheduler 唯一持有 pump 和 active；TaskExecution 负责 Harness 执行与事件回执；工具注册归 collaboration-tools。旧 app/collaboration.ts 已退出，没有第二套运行队列。 |
| M05 证据恢复 | TaskRecovery 独立处理事实核对和恢复；CoreAssurance 通过所需成员的窄类型访问任务，审查窗口查找使用独立接口。原有副作用、不确定状态、独立证据和版本校验保留。 |
| M06 KIM 团队 | CorePlanning 状态与规划逻辑归 application/planning-service，工具注册及 Harness 钩子归 adapter；团队与跟进服务迁入 application。核心通过 SessionPort/WorkspacePort 使用宿主能力，不再导入 app 控制器。 |
| M07 展示命令 | 命令目录从 TUI 迁入 app/commands；独立会话帮助、工作台帮助、设置帮助与斜杠推荐共用目录。workspace-commands 承接工作台命令执行，TUI 继续负责显示、草稿、焦点和输入事件。取消主窗口归协调用例。 |
| M08 规则清理 | 更新源码、测试、探针与巡检脚本的调用路径，删除被替代的旧实现/转导出，整理未使用导入和重复帮助文案。启用 noUnusedLocals/noUnusedParameters；格式检查由 24 个指定文件扩展至 283 个自有 TS/TSX 文件。 |

核心对 app 的反向导入：**23 → 0**（包括类型导入）。当前静态盘点 125 个 TS/TSX/Python 源文件。格式化将许多单行逻辑展开，因此行数增长不等于新增同等数量的功能代码；品牌母版、生成 Logo 数据和 vendor 未参与格式化。

`npm run check` 现在包含类型检查、格式检查、架构检查。架构检查覆盖 core→app、纯领域依赖、直接任务写入以及裸 Promise。显式 void 只表示后台执行意图，错误仍需由 track/catch 等调用方负责；该检查不是完整的异步正确性证明。

## 验证结果

证据目录：`artifacts/iteration-20261108-phase2/`（本机保存，不提交原始记录）。

| 验证 | 结果 / 证据 |
| --- | --- |
| 完整既有测试 | 242/242，通过；full-tests.log，test-concurrency=2 |
| 新增架构/存储行为测试 | 2/2，通过；boundary-tests.log。覆盖终态不能复活、元数据不能绕过状态机、损坏文件及超预算替换保留原文件 |
| 最后 Code 存储迁移复测 | 7/7，通过；code-final.log，包含真实本地 PowerShell/文件工具与类型检查 |
| TypeScript | 通过；typecheck.log，启用未使用声明检查 |
| 格式 / 架构规则 | 283 个文件格式通过；123 个 TS/TSX 源文件 0 架构违规；style.log、architecture-check.log |
| TUI 无头交互 | 三套脚本、28 项断言通过；tui-core1.log、tui-workspace.log、tui-master.log |
| 构建 | 通过，包含原生模型配置工具；build.log |
| 安全扫描 | 10647 个文件，2 份已保存凭据，明文命中 0、读取错误 0；security/security.json |
| npm 依赖审计 | 0 项已报告漏洞；同上 |
| Git 差异空白检查 | 通过；diff-check.log |

首轮全量为 240/242：一个测试替身仍按旧接口提供回执写入，已更新到实际生命周期接口；另一个真实本地命令测试在并发压力下超出轮询等待。后者隔离运行通过、限制并发后的完整测试通过、最终 Code 复测通过。没有放大生产超时阈值或删除断言。原始失败日志仍保留。

TUI 验证包括中文命令筛选/补全、帮助保留草稿、思考/写入/就绪状态、任务详情、窄屏返回、审批不抢焦点、主控暂停恢复及接管释放。它们是无头渲染与本地 Harness 集成测试，不冒充本轮实际 Windows Terminal/鼠标真机全流程验收。

## 兼容与剩余阶段

配置、工作台、计划、记忆与 SQLite 格式继续保持 v1。SQLite 权威状态优先、启动暂停、不重放历史副作用、外部 Skill/MCP 和原生配置接口继续保留。安全扫描只匹配已知凭据；npm 审计不涵盖 Python 依赖或未知逻辑漏洞。

第三阶段仍需处理 work_json/plan_json/checks_json 的结构化工具协议、明确错误反馈，以及最终构建上的真实模型派工矩阵。发行资源、干净安装、许可和 GitHub 发布按后续阶段推进。本轮没有调用付费模型、发布或声称已完成这些验收。

本轮重构是同一运行路径的职责迁移；事件仍在组合入口装配，组件通过明确端口访问宿主。并未宣称所有应用层到 adapter 的装配依赖已变成严格的依赖注入框架，也未为追求文件数量重写成熟的上游 Harness。
