# 第一阶段行为验收清单

本表固定结构整理必须保留的行为及验证入口。测试文件名相对于 `emergence/tests/`；带历史宿主的用例必须按 [退役清单](retirement.md) 迁移，不能据此重新启用跨窗口控制。

## 行为与现有验证入口

| 编号 | 必须保留的行为/失败边界 | 验证入口与适用限制 |
| --- | --- | --- |
| B01 | 多窗口分别选择项目/模型/会话，分屏和关闭不丢其他窗口草稿 | `independent-windows.test.ts`、`workspace.test.ts`、`pane-close.test.ts`、`tui-independent-windows.ts` |
| B02 | 命令、直接调用、恢复旧配置均不能开启跨窗口控制 | `independent-windows.test.ts` 的退役入口/历史恢复用例，`tui-independent-windows.ts` 的菜单与主控标识检查 |
| B03 | 首页首次提交进入对话，中文输入/斜杠推荐、消息和工具详情、窄屏导航 | `tui-phase1.ts`、`tui-phase2.ts`、`tui-phase3.ts`、`tui-phase4.ts`、`message-model.test.ts`；第五阶段还需真实终端验证 |
| B04 | 审批/提问可交互，拒绝和取消有效，失效或错会话的回答不能授权工具 | `interactions.test.ts`、`permissions.test.ts`、`approval-events.test.ts`、`tui-core-phase1.ts`、`tui-approvals-r3.ts`；历史宿主覆盖随执行引擎迁移 |
| B05 | KIM 内置能力、自动需求理解、澄清、规划与停止预算可工作 | `core-foundation.test.ts`、`runtime-intake.test.ts`、`core-planning.test.ts`、`planning-clarification.test.ts`、`tui-intent.ts`；本地模型不代表真实供应商效果 |
| B06 | 本窗口计划经实际 Harness 工具执行，完成需匹配产物与证据 | `independent-windows.test.ts` 的实际文件执行用例、`core-execution.test.ts`、`report-admission.test.ts`、`completion-evidence.test.ts` |
| B07 | 任务状态有单一入口，重复提交、超预算、迟到回执不产生重复执行 | `architecture-boundaries.test.ts`、`task-admission.test.ts`、`scheduler-budgets.test.ts`、`dispatch-lifetime.test.ts`、`task-failures.test.ts` |
| B08 | SQLite 真相优先，旧快照和未知副作用不能变成成功或被自动重放 | `architecture-baseline.test.ts`、`core-execution.test.ts`、`acceptance-replay.test.ts`、`safe-json-file.test.ts` |
| B09 | 模型请求恢复、截断、错误协议有明确结果，请求重试不等于重放工具 | `request-recovery.test.ts`、`request-recovery-http.ts`、`phase6-faults.ts`、`model-response.test.ts` |
| B10 | EMERGENCE.md 等规则的来源/优先级/作用域有效，内容不扩大执行权限 | `instructions.test.ts`、`experience-e3-terminal.ts`、`audit-security.test.ts` |
| B11 | Code 检索、忽略规则、文件基线、修改后的检查与验证证据 | `code-understanding.test.ts`、`code-workflow.test.ts`、`code-data-foundation.test.ts`、`code-data-integration.test.ts` |
| B12 | Data 输入保护、口径确认、SQL/执行限制、固定 Python 环境、失败及结果交付 | `data-foundation.test.ts`、`data-analysis.test.ts`、`data-runtime.test.ts`、`code-data-integration.test.ts`；数据环境及依赖锁需匹配 |
| B13 | 记忆的批准/遗忘/隔离和证据有效期保持 | `core-memory.test.ts`、`core-assurance.test.ts`；共享证据用例保留，跨窗审查宿主迁移 |
| B14 | Skills、MCP、显式扩展的连接/工具注册/禁用与收尾正常 | `phase2-e2e.ts`、`phase5.test.ts`、`integration.test.ts`、`phase5-terminal.ts`；协议夹具与线上服务验证分开记录 |
| B15 | CLI 非交互请求、会话恢复、模型参数和错误退出行为保持 | `phase2-e2e.ts` 的真实 CLI 子进程场景；不能只测试 Controller 内部方法 |
| B16 | 原生模型配置增改删、DPAPI、修订冲突、运行中分配及服务退出 | `model-configuration.test.ts`、`model-config-lifecycle.test.ts`、`model-config-runtime.ts`、`credentials.test.ts`、`phase5-native-config.ts`；实际 Windows Forms 操作在第五/七阶段补验 |
| B17 | Tokens 来自实际回执，状态与错误可见，显示缓存不改变执行真相 | `session-usage.test.ts`、`tui-auxiliary.test.ts`、`run-diagnostics.test.ts`、`tui-phase3.ts` |
| B18 | Windows 路径别名/中文路径、越界检查、秘密脱敏不破坏结构化合同 | `code-workflow.test.ts`、`code-understanding.test.ts`、`task-admission.test.ts`、`project-contract.test.ts`、`audit-security.test.ts` |
| B19 | 反复打开/关闭、取消和超时后释放订阅、进程和租约 | `audit-stress.ts`、`phase6-stability.ts`、`model-config-lifecycle.test.ts`、`pane-close.test.ts`；独立运行稳定性检查，避免构建资源竞争污染结果 |
| B20 | 安装、升级、卸载验证包完整性且保留用户数据 | `phase6-release.ts`、`release-bootstrap.ps1`，发布后公网下载验收；第七阶段使用新候选版本，不覆盖 1.00 |

## 各阶段验证安排

| 阶段 | 必需证据 |
| --- | --- |
| 第一阶段 | `npm run check`；架构/独立窗口 7 项定向回归；独立窗口 TUI；产品源码/原生源码/依赖/测试保全及文档引用检查 |
| 第二阶段 | check、常规回归；重点 B05/B06/B10/B11/B12/B18，重新生成依赖图并验证具体实现反向依赖退出 |
| 第三阶段 | check、常规回归；重点 B01/B02/B06/B07/B08/B13；逐项记录测试宿主迁移与退役生产调用清零，执行受影响完整矩阵 |
| 第四阶段 | check、常规回归与 inspect:full；重点 B04/B05/B06/B07/B08/B09/B14/B17/B19，核对状态和资源只有一个归属 |
| 第五阶段 | check、build、常规回归与 inspect:full；真实终端和 Windows Forms 验证 B01/B03/B04/B16/B17/B19，核对原生构建输入 |
| 第六阶段 | 统一多语言检查、构建、常规及受影响回归；确认开发检查没有增加用户运行依赖 |
| 第七阶段 | 固定最终源码重跑完整矩阵、安全/依赖/秘密检查、真实终端/原生工具、历史兼容、稳定性和候选包安装链路 |

如某项发现行为缺陷，在对应阶段修复并复验；表格列出入口不等于已经执行。因职责迁移调整测试数量时必须有去向记录，不删断言或放宽通过标准。

## 第一阶段实际结果

- `npm run check` 通过：类型检查、355 个格式检查文件、153 个 TS 源文件的现有架构规则。
- `architecture-boundaries.test.ts`、`architecture-baseline.test.ts`、`independent-windows.test.ts`：7/7 通过，失败/跳过均为 0。
- `tui-independent-windows.ts`：4 项通过，覆盖独立窗口、右键菜单、分屏保留草稿和关闭/窄屏。
- 发布版 397/397 仅作为原行为参考，见 [发布 CI](https://github.com/shianlab/emergence/actions/runs/43842973292)；不是本阶段重新执行的数量。
- 本阶段产品源码与依赖未变，未再运行付费供应商、完整压力测试、人工桌面全流程或安装升级；这些是后续阶段的明确验收项。

日志及最终核对保存在 `artifacts/structure-phase1-20261116/`，详见 [基线](baseline.md)。
