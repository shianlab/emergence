# Changelog

## 1.07 / 1.0.7 — 2026-11-20

- 模型凭据由应用按需读取，普通工具子进程不继承模型密钥。统一错误脱敏及 Windows 路径校验。
- 任务台账保存删除与顺序变更。取消或关闭会话时释放任务的只读限制，即使首次保存失败也会继续收尾。
- 在线更新保留安装失败原因，安装超时后交由现有事务流程恢复。
- 工作台空闲时停止轮询和重复重绘。编程提示以独立会话为范围，修正旧模板校验提示与 Markdown 字符显示。
- 校验数据分析进程的结果结构及 Excel 解包预算。Windows x64 安装包省去调试符号和其他架构的终端预编译文件。

见 [1.07 发布说明](docs/releases/1.0.7.md)。

## 1.06 / 1.0.6 — 2026-11-19

- 对话区采用完整细灰边框，保留多行输入空间，并拉开会话标题、输入框与底栏的距离。
- 支持图形协议的 Windows 终端缩小模型说明、普通回执和目录 / Tokens 等辅助信息。正文、输入、审批和错误继续使用可复制的原生文字。
- 模型只在窗格顶部显示一次，目录集中在底栏。修正分屏和缩放时辅助文字造成的滚屏、重影及底栏遮挡。
- 修复部分 Windows 环境下小字绘制进程查找系统模块超时的问题。
- 模型输出截断未提交的工具调用时，在原任务内缩短该步骤并重试一次。PDF 和长文档按分段写稿、独立转换和检查交付物处理。

见 [1.06 发布说明](docs/releases/1.0.6.md)。

## 1.04 / 1.0.4 — 2026-11-18

- 新增「狂暴模式」。开启后，当前窗口自动批准工具调用，包括 Shell、项目外文件操作和 MCP。原有操作系统权限、工具校验、任务只读及禁止约束继续生效。
- `Shift+Tab` 循环切换计划、询问、自动编辑、自动执行和狂暴模式。也可从 `/permission` 菜单选择，或直接输入 `/permission rage`。
- 分屏各自独立，重启后使用常规默认权限。数据口径如果经狂暴模式批准，记录与报告会标注自动批准。
- Windows 发行包移除已禁用的 Harness 热重载所用的 `picomatch`，规避新披露的依赖问题。

见 [1.04 发布说明](docs/releases/1.0.4.md)。

## 1.03 / 1.0.3 — 2026-11-17

包含 1.02 的安装与签名更新能力，修正最终重复验收发现的 Windows 快照读取竞态，以及审批拒绝后等待保存时仍可能发起下一次模型请求的问题。1.02 已公开资产保持不变，稳定通道使用 1.03。详见 [1.03 发布说明](docs/releases/1.0.3.md)。

## 1.02 / 1.0.2 — 2026-11-17

- 为安装下载增加限时重试、续传、校验缓存与分阶段诊断，降低失败后的重复下载成本。
- 统一安装、更新、修复、回退及中断恢复事务，启用前验证实际启动，保留使用中的版本和用户数据。
- 加入后台稳定版检查、中文 `/update` 菜单与 CLI 在线更新；默认通知后由用户选择安装。
- 更新清单使用发布者签名，应用和安装器双重验证，限制来源、大小、版本及发行序号。
- 明确旧用户一次性迁移、后续更新、清理与回退路径。新增 PowerShell 5.1/7 与旧版实包迁移验收。

本机完整矩阵已通过，用户另行确认外部电脑安装、模型配置与实际任务正常。见 [1.02 发布说明](docs/releases/1.0.2.md)。

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
