# 第二阶段交付报告

版本：0.0.2-phase2。日期：2026-10-29。

## 交付范围

- 本机 `emergence` 命令已安装，支持当前/指定目录、帮助、版本、模型配置、显式恢复与 JSON 输出。
- 正式启动通过 `dsh --profile emergence`，采用官方 base bundle 与自有 UI 插件，未复制 Agent 循环、工具或持久化格式。
- 单窗格具备多行输入、流式输出、工具参数与结果、失败状态、滚动、取消和退出。
- 模型配置使用验证过的 JSON，密钥引用环境变量，支持下一轮切换及恢复时模型一致性。
- 已连接真实文件工具、PowerShell、审批、问卷、JSONL、Skill 与 stdio MCP。

## 验证

见 [巡检摘要](../../artifacts/phase2/inspection-summary.md)、[完整记录](../../artifacts/phase2/inspection.json)、[工具链记录](../../artifacts/phase2/e2e.json)、[终端记录](../../artifacts/phase2/terminal.json)。

本地 HTTP/SSE 测试服务驱动真实 Harness 供应商适配器。服务只控制模型回复，实际运行了创建文件、读取、修改、PowerShell 验证、Skill 正文加载、MCP echo，并跨进程恢复会话。测试要求链中每个工具成功，不能仅凭模型最后的成功摘要通过。

另验证 OpenAI Chat Completions 与 Anthropic Messages 两种协议、缺少密钥、HTTP 401 及诊断脱敏。真实 Windows ConPTY 验证问卷回答、拒绝/允许命令、取消流式 HTTP 请求、界面内换模型、Ctrl+C 返回 shell，以及审批/问卷结果保存。

## 巡检中的修复

1. profile 启动增加就绪回执与超时，避免应用插件未加载时无限驻留。
2. M 盘上的 Windows AppContainer 写权限授予失败。明确采用可配置 shell 策略：默认 `ask-local`，每次本地命令必须确认；可选 `sandbox`，不静默降级。该模式显式禁用不兼容的上游 shell 权限预设，保留文件策略。
3. PowerShell 测试补齐必需参数，并增强断言捕获工具失败。
4. 恢复时保留持久化模型选择，只有显式 `--model` 才覆盖。
5. 长问卷/命令确认改用可滚动主区域，避免被提示区高度截断。
6. 配置拒绝内嵌密钥和含凭据的 URL；日志、界面转录与实时输出对密钥环境变量值脱敏。

## 待补验和边界

用户提供凭据后，已通过 DeepSeek 官方认证与 `deepseek-flash` 真实验收：模型实际写入并读回验证文件，并跨进程恢复会话，见 [真实调用记录](../../artifacts/phase2/live-deepseek.json)。凭据通过 Windows DPAPI 绑定当前用户加密保存，启动时注入运行时环境变量，不写入工程或报告。默认模型参数依据 [官方首次调用文档](https://api-docs.deepseek.com/)。另一家真实供应商仍未调用，计划中 S2.4 保持待补齐。

凭据补验后再次完成 7 组自动巡检，其中配置/凭据/路由回归共 8 项通过；对工程、测试、文档、阶段二产物及涌现配置目录共 206 个文件检查，未发现明文密钥，见 [凭据检查摘要](../../artifacts/phase2/credential-check.json)。用户提供的原始密钥文件不属于此次工程泄漏扫描范围。

物理中文输入法、字体和剪贴板 UI 仍需人工检查。当前显示最近 200 条事件、单条最多 16000 字符，完整事件仍保存；MCP 本阶段提供 stdio 配置，完整管理后续完善。

多窗格和主控派活分别属于第三/四阶段。当前安装为本地开发链接，尚未制作独立安装包。ConPTY 专用测试驱动沿用阶段一的显式结束方式，应用及 shell 自身先正常退出。

## 使用

```powershell
cd M:\你的项目
emergence
```

当前用户已配置加密凭据，可以直接启动。更新凭据可使用 `emergence auth --key-file <路径>`。完整说明见 [应用 README](../../emergence/README.md)。
