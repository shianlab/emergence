# Emergence · 涌现

Emergence 是独立的多窗口终端 Agent 应用，底层使用 DeepSeek Harness。产品身份、交互、权限与规则文件由 Emergence 管理；供应商和开源组件归属保持准确。

2026-11-16 起取消主控和跨窗口协同：各窗口独立接收用户任务，不能控制、派活或自动开窗交给其他窗口。保留单会话 KIM、原生子代理、编程、数据、记忆、Skills/MCP 和审批。工作台执行范围固定为 session，无配置开关恢复协作；TaskEngine 承担本窗口计划与执行，历史兼容测试保留读取和安全证据，不构造退役主控宿主。

## 项目结构

- `src/app/controller.ts`：会话组装与协调；session-lifecycle、session-permissions、session-presentation 分别拥有会话生命周期、权限和显示投影。
- `src/app/workspace.ts`：窗口与工作台持久化；`src/core/application/task-engine.ts`：本会话任务准入与执行。TaskLifecycle 是任务状态写入入口。
- `src/core/domain/`、`src/core/application/`、`src/core/adapters/`、`src/core/storage/`：分别负责规则、流程、Harness 适配和持久化；当前维护约定见 [结构维护入口](../docs/structure/README.md)，旧编排文档仅供历史追溯。
- `src/core/domain/permissions.ts`、`src/core/adapters/permissions.ts`：权限规则与实际路径核对。
- `src/app/instruction-files.ts`、`src/app/instructions.ts`、`src/app/instruction-init.ts`：规则来源、作用域、模型上下文和初始化。
- `src/platform/`：路径关系、内容哈希和有界文本读取；规则文件模块不再作为 Code/Data 的基础工具入口。能力宿主与代码证据契约见 [第二阶段报告](../docs/structure/phase2-report.md)。
- `src/app/workspace-ui.ts`、`src/app/tui/`：终端交互与首页；尊重独立 UI 工作窗口的最新改动。
- `tests/`、`scripts/inspect-*.ts`：实际 Harness、本地模型服务、原生渲染器和 ConPTY 验证。
- 上级 `docs/` 保存阶段方案；`artifacts/` 保存巡检证据。

## 开发和验收

- `npm run setup:quality`：准备隔离的开发检查工具，详见 [编码规范](../docs/structure/coding-standards.md)。
- `npm run check`：严格类型、TS/C#/Python/PowerShell 格式与静态检查、核心分层/任务写入边界检查。
- `npm test`：常规回归。
- `npm run build`：构建本机 `emergence` 使用的产物。
- `npm run inspect:full`：当前产品完整矩阵，包含多语言检查；历史阶段名称不授权恢复退役功能。
- 检查与构建使用项目锁定的 Node 26；原生渲染额外启用 `--experimental-ffi`。不要用全局 Node 24 的结果代替支持版本验收。
- 本地模型测试与真实付费模型调用分开；不得将模拟模型成功描述成真实供应商验收。

## 工作约定

界面遵循黑白灰和已确认的手写魏碑标识。保留“先首页、首次提交后进入对话”的流程。修改共享文件前读取最新内容，保留其他窗口的变更。

模型、执行权限和协作方式相互独立。所有 Agent 工具和子任务遵守运行时权限；Markdown 不授权命令、扩展或配置修改。会话授权只存内存，恢复历史不得自动重放外部操作。

已发布 1.00 / 1.0.0 是本轮结构整理的行为基线。按 [七阶段方案](../docs/structure-refactor-plan-2026-11-16.md) 推进，不覆盖旧发行物；后续发布按用户指令进行。密钥不写入本文件、源码、测试证据或输出。

报告实际行为、验证结果及未覆盖项。工具失败或未完成任务不能被模型的成功总结覆盖。
