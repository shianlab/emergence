# 第一阶段交付与巡检报告

日期：2026-10-29。目标：完成技术原型、接口验证和架构选型，为第二阶段真实应用实现提供依据。

## 已交付

- 独立工程 `emergence/`，版本 `0.0.1-phase1`，使用依赖锁。
- 原始 zip 保留，参考源码位于 `references/`，未修改上游实现。
- [能力清单](capabilities.md)、[架构决策](architecture.md)、[界面方案](interface.md)。
- 真实 Harness 核心运行时探针、dsh-TUI renderer 源码对照原型、OpenTUI 原生原型及巡检入口。

## 结果与选型

选择 TypeScript + OpenTUI 0.7.0 + Node 26.4.0，Harness 基线为 0.2.2-alpha.2，通过进程内公开 Agent/插件接口接入。Node FFI 是实验功能，脚本显式启用，后续分发固定版本并回归。Bun 1.4.4 保留为对照环境。

Harness 验证运行真实 Registry、AgentLoop、Inbox、NativeToolExecutor 和 Session。provider 的输出由测试控制，未调用外部供应商。已验证独立路由、取消模型流、取消真实工具、另一会话继续完成、所属目录读取、工具结果记入事件、取消后继续使用、下一轮模型切换、后续排队、单个和全部 Agent 释放。

OpenTUI 在 Node 和 Bun 下通过了 2/4 区域渲染、中文/emoji 粘贴、焦点隔离、独立滚动、窄屏与草稿保持、恢复宽屏和受控流式更新。Windows ConPTY + VT 解析器进一步验证真实终端字节流中的输入、粘贴、缩放、Ctrl+C、备用屏退出和返回 shell。

## 巡检发现与处理

1. 原型的目录参数和 Cordis 释放方式已按当前公开 API 修正，并由严格类型检查验证。
2. dsh-TUI renderer 的 reconciler peer 要求 React 19.3，已锁定兼容版本，没有强制跳过依赖冲突。
3. OpenTUI 测试工具 `typeText` 使用 `split('')`，会拆开 emoji 代理对。改用完整 UTF-8 粘贴后通过，并经 ConPTY 独立输入验证；未把辅助工具问题误判为渲染器问题。
4. 旧 tsx 在 Node 26 输出弃用警告，已更新到 4.23.15。后续产品日志必须与 UI 生命周期统一管理。
5. dsh-TUI 最小对照原型在系统 ConPTY 初测未通过窄屏草稿可见性检查，换用附带 ConPTY DLL 后原断言通过。两条路线最终均可运行，OpenTUI 的选型主要基于输入/滚动组件和维护范围，不能以初测结果认定上游产品存在通用缺陷。
6. 路由回归覆盖错会话、重复请求 ID、取消后晚到回答及后台输出，防止焦点变化改变请求归属。
7. node-pty 1.1.0 在界面及 shell 自然退出后保留测试进程的 Windows conout worker。专用 ConPTY 驱动在收到子进程退出、完成断言与落盘后显式结束；不作为产品生命周期实现使用，不将此处理包装成运行时资源自动释放证明。Harness 自身释放另由 Registry 清空检查验证。

最终自动巡检 7 组检查均通过；两个原始压缩包 SHA256 未变，依赖锁一致，结束后未发现本轮 Node/Bun 测试进程残留。详见 [摘要](../../artifacts/phase1/inspection-summary.md) 与 [完整记录](../../artifacts/phase1/inspection.json)。选定路线必须通过，全部候选的最终检查和画面保留在 `terminal.json`。系统 ConPTY 初测差异见上方记录。

## 待补验与当前边界

- 当前未提供外部模型 API 密钥，没有真实模型网络调用，不宣称供应商已端到端兼容。
- ConPTY 不覆盖物理中文输入法候选框、字体、系统剪贴板 UI，以及 Windows Terminal/VS Code 的人工视觉检查。
- 真实审批/问卷接入界面、持久化恢复和 Skill/MCP 的完整流程在第二阶段交付；自有路由测试不代替这些集成测试。
- 受控工具的目录测试不代表标准 shell、文件服务和工作目录切换已全部验证。
- 四区域原型纵向排列；任意分屏、拖拽、任务列表和主控调度尚未实现。F2 仅切换模式草图标记。
- 全局 `emergence` 命令在第二阶段注册；当前用 npm scripts 运行原型。

第一阶段工程验证与选型已形成可复跑成果，外部模型和人工终端验收保持待补验。第二阶段可沿已验证路线开始，完成真实 profile 启动和单窗格任务链路。

## 运行

```powershell
cd M:\涌现TUI\emergence
npm run demo
npm run inspect
```

原型输入只保留本地草稿，输出为明确标记的受控事件流。巡检 JSON 不含密钥值。
