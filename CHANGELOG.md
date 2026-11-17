# Changelog

## 1.01 / 1.0.1 — 2026-11-17

本次为结构整理和稳定性更新，保留独立多窗口及现有单会话能力。

### 优化与修复

- 整理会话生命周期、权限、规划和任务状态的责任边界，修正会话切换及迟到结果处理中的竞态。
- 清除退役的跨窗口协调实现，保留旧数据读取兼容；不恢复主窗口或跨窗口派活。
- 理顺 Code/Data 的能力接口，分离 TUI 输入、窗口视图、提示，以及原生配置工具的草稿与连接生命周期。
- 减少界面刷新时重复读取脱敏信息造成的输入延迟；密钥轮换后继续立即生效。
- 将自有 TypeScript、C#、Python、PowerShell 统一纳入固定版本的格式和静态检查。
- 补全在线文件执行的回执验收，区分 KIM 的分析拦截及后续成功恢复，不隐藏未知或重复失败。

### 兼容与验证

- 保留配置、加密密钥、历史与项目数据；支持从 1.00 升级及通过旧包回退。
- 保留中文 TUI、KIM、Code/Data、Skills/MCP、记忆、审批和原生模型配置。
- 更新安装默认版本及中英文使用文档。详细范围、验收记录和限制见 [1.01 发布说明](docs/releases/1.0.1.md)。

Maintenance release: clearer session/planning ownership, retired coordination removal, TUI input performance improvements, native configuration lifecycle cleanup, and consistent multi-language checks. Existing configuration, encrypted credentials and history remain compatible.

## 1.00 / 1.0.0 — 2026-11-16

First public Windows x64 release of Emergence Harness.

- Chinese-first terminal workspace with command discovery, Markdown, execution status and keyboard approvals.
- Independent panes, per-pane projects and models, history and cancellation.
- Integrated KIM requirement intake, planning, evidence and memory.
- Coding and local data-analysis tools, Skills/MCP and project instructions.
- Native Windows Forms model configuration with DPAPI credential storage.
- Windows bundle, SHA-256 checks, per-user command-line installation and data-preserving uninstall.
- MIT license, bilingual README, contributor/security guidance and Windows CI.

Cross-pane control and delegation are not part of this release. macOS, Linux and ARM64 packages are not available. See [release notes](docs/releases/1.0.0.md).
