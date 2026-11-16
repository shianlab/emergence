# Emergence · 涌现

Emergence 是独立的多窗口终端 Agent 应用，底层使用 DeepSeek Harness。产品身份、交互、权限与规则文件由 Emergence 管理；供应商和开源组件归属保持准确。

2026-11-16 起取消主控和跨窗口协同：各窗口独立接收用户任务，不能控制、派活或自动开窗交给其他窗口。保留单会话 KIM、原生子代理、编程、数据、记忆、Skills/MCP 和审批。工作台执行范围固定为 session，无配置开关恢复协作；保留任务引擎用于本窗口计划和历史证据，旧图安全回归使用仅测试目录内的历史宿主。

## 项目结构

- `src/app/controller.ts`：会话和原生子代理归属、交互请求、工具权限。
- `src/app/workspace.ts`：窗口与工作台持久化；`src/core/application/task-coordinator.ts`：唯一任务队列与协调。
- `src/core/domain/`、`src/core/application/`、`src/core/adapters/`、`src/core/storage/`：分别负责规则、流程、Harness 适配和持久化；编排约定见上级 `docs/orchestration-maintenance.md`。
- `src/core/domain/permissions.ts`、`src/core/adapters/permissions.ts`：权限规则与实际路径核对。
- `src/app/instruction-files.ts`、`src/app/instructions.ts`、`src/app/instruction-init.ts`：规则来源、作用域、模型上下文和初始化。
- `src/app/workspace-ui.ts`、`src/app/tui/`：终端交互与首页；尊重独立 UI 工作窗口的最新改动。
- `tests/`、`scripts/inspect-*.ts`：实际 Harness、本地模型服务、原生渲染器和 ConPTY 验证。
- 上级 `docs/` 保存阶段方案；`artifacts/` 保存巡检证据。

## 开发和验收

- `npm run check`：严格类型、全自有 TypeScript 格式与核心分层/任务写入边界检查。
- `npm test`：常规回归。
- `npm run build`：构建本机 `emergence` 使用的产物。
- `npm run inspect:full`：当前产品完整矩阵；`historical:*` 只保留旧阶段研究入口。
- 检查与构建使用项目锁定的 Node 26；原生渲染额外启用 `--experimental-ffi`。不要用全局 Node 24 的结果代替支持版本验收。
- 本地模型测试与真实付费模型调用分开；不得将模拟模型成功描述成真实供应商验收。

## 工作约定

界面遵循黑白灰和已确认的手写魏碑标识。保留“先首页、首次提交后进入对话”的流程。修改共享文件前读取最新内容，保留其他窗口的变更。

模型、执行权限和协作方式相互独立。所有 Agent 工具和子任务遵守运行时权限；Markdown 不授权命令、扩展或配置修改。会话授权只存内存，恢复历史不得自动重放外部操作。

本阶段优先本机运行和反复调试；安装包和 GitHub 发布按用户后续安排进行。密钥不写入本文件、源码、测试证据或输出。

报告实际行为、验证结果及未覆盖项。工具失败或未完成任务不能被模型的成功总结覆盖。
