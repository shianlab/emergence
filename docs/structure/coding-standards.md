# Emergence 编码规范与检查入口

适用于当前独立多窗口产品。职责和状态边界以 [维护入口](README.md)、[会话与规划指南](session-planning.md)、[界面指南](ui-maintenance.md) 为准。

## 准备开发环境

当前受支持的完整检查环境为 Windows x64、Node 26.13.0、Python 3.14、PowerShell 7（准备工具）与系统 Windows PowerShell 5.1（脚本兼容检查）。C# 排版使用 `.NET SDK 8.0.426`，`emergence/global.json` 禁止自动滚动到其他 SDK；原生应用仍由系统 Framework 编译器构建，运行目标仍是 .NET Framework 4.8。

在 `emergence/` 目录执行：

```powershell
npm ci
npm run setup:quality
npm run check
npm test
```

如 Python 不在 PATH，可执行 `npm run setup:quality -- -Python C:\路径\python.exe`。数据集成测试另按原流程初始化 `.data-venv`；检查工具不会安装到这个运行环境。

`setup:quality` 只在被忽略的 `.quality-tools/` 下准备 Ruff 与 PowerShell 模块，不修改系统模块，不安装模型配置插件，不改变用户模型或密钥。不把开发 SDK、Python 检查环境和分析模块装入发行包。安装 SDK 属于开发机准备；脚本发现缺失或版本不匹配会失败并提示，不静默跳过。

## 固定工具与检查范围

| 语言 | 格式 | 静态检查 | 固定位置 |
| --- | --- | --- | --- |
| TypeScript | Prettier 3.9.10 | TS 5.9.3 严格类型、未用变量/参数、项目架构与状态写入检查 | package/lock、tsconfig、.prettierrc |
| Python | Ruff 0.14.10 | E4/E7/E9/F：导入错误、语法问题、未定义/未用名称和容易混淆的写法 | ruff.toml、quality/requirements.txt 的 Windows x64 wheel 哈希 |
| C# | SDK 8.0.426 自带 dotnet format whitespace | 系统 Framework 编译器，C# 5、warning level 4、所有编译警告视为错误 | global.json、.editorconfig、check-languages.ts |
| PowerShell | PSScriptAnalyzer 1.24.0 格式器 | 5.1 语法解析与明确规则集，含动态字符串执行、明文口令写法、空 catch、未用变量及排版 | quality/toolchain.json、quality/powershell.psd1 |

PowerShell 规则使用显式 IncludeRules，当前没有逐文件或全局 suppress/ignore。它是一组适合现有安装/维护脚本的约束，不声称已启用分析器的所有建议或能证明脚本绝对安全。C# 编译检查不等于全面语义分析；TS 严格类型也不能证明所有异步异常都已处理，仍需下列人工审查及回归测试。

自有文件由 `scripts/source-files.ts` 统一发现：src、scripts、tests、probes、native、release、bin、quality，另纳入仓库根 install.ps1。不跟随符号链接。新建文件放入这些维护目录后自动纳入对应语言检查。

准确排除：

- `src/core/assets/catalog.ts`：导入的 KIM 资产目录。
- `src/app/tui/home-logo-data.ts`、`src/app/tui/logo-data.ts`：生成的标识数据。
- vendor、node_modules、dist、assets、参考、artifacts、旧 acceptance-dist、副本及开发工具环境不属于手写源码发现根目录。

不重排第三方许可证、导入资产或生成文件；它们沿用来源、许可和哈希验证。不要为规避违规把自有实现搬到排除目录。新增生成文件排除项须说明生成入口、来源及校验方法。

## 日常命令

- `npm run check`：类型、四种语言规范、架构；CI 使用同一入口，任一步失败即失败。
- `npm run check:typescript / check:python / check:native / check:powershell`：按语言定位问题。
- `npm run format`：统一自有代码排版；相应 `format:typescript / format:python / format:native / format:powershell` 用于单语言。
- `npm run inspect:full`：多语言规范、完整构建、单元/Harness、配置协议、故障恢复、OpenTUI 与 ConPTY 全矩阵。
- `npm run inspect:security`：已保存凭据匹配和 npm 依赖审查；未知秘密、外部服务与工具自身漏洞仍需单独判断。

检查命令只检查，不写源码。format 只进行排版，不自动删除导入、改名称、改控制流或应用 Ruff 的语义修复。静态问题必须单独修改并检查行为。

`check-orchestration.ts` 已更名为 `check-typescript.ts`；内部调用全部迁移。仅保留 package 命令 `format:orchestration` 作为旧命令到 `format:typescript` 的兼容别名，不保存重复实现，新文档和 CI 不使用旧名称。

PowerShell 统一 CRLF、UTF-8 BOM；这是为了 Windows PowerShell 5.1 下的中文兼容。格式器先统一换行并去除行尾空白，再检查规范。需要作为数据保留的空格应使用明确的字符串字面量或独立数据文件，不依赖源码行尾空白。

## 代码审查规则

1. **按职责命名。** 文件名描述领域或行为，不使用不断扩张的 misc/helpers 大容器。TS 模块采用现有 kebab-case，类型使用 PascalCase，函数/变量用有意义的 camelCase；Python 函数/变量用 snake_case。不要用 `l`、`O` 等容易混淆的名称表达业务数据。
2. **唯一状态。** 任务经 TaskLifecycle、审批经 InteractionQueue、规划经 PlanningRequests、会话经 SessionLifecycle 操作。UI 消费投影；禁止重新复制权威状态或绕过审批请求身份。
3. **明确依赖。** core 与 Code/Data 经已有端口协作，不反向导入 app 实现。类型使用显式契约、联合类型及 unknown 收窄；不以 any、非空断言或宽泛类型转换掩盖边界缺失。纯类型导入应使用 type，旧代码的渐进整理与具体修改同行审查。
4. **异步有归属。** 每个后台 Promise 必须 await，或显式处理失败并核对当前会话/请求；事件回调中不要依赖无法传递的 async 返回值。切换、取消与关闭要定义等待、释放及迟到结果处理，防止报错跳过清理。
5. **错误有含义。** 避免吞掉异常。清理中的容错必须说明可忽略原因，保留必要诊断；不得自动重放未知副作用。日志和异常对用户输出前脱敏。
6. **复杂度看责任。** 一个方法同时做 IO、权限判定、状态转换和 UI 更新时必须审查拆分边界；嵌套条件优先提取有名称的领域判断。重复规则归于现有权威实现，不为每次特例增加并行流程。不设置“超过多少行必须拆文件”的机械门槛。
7. **测试验证行为。** 覆盖错误身份、取消/超时、持久化兼容、资源收尾和真实回执；不要为通过检查删断言、加无条件重试、扩大预算或添加没有依据的忽略项。
8. **变更可审查。** 排版与行为调整应分开提交；已有未提交工作不得混入新的规范提交。本轮保留排版前/后快照和单独排版补丁，作为前五阶段尚未提交情况下的审查边界。正式提交时先整理已有工作，再应用对应批次，不把所有差异一次性归为“格式化”。

## CI 与证据

Windows CI 在 npm ci 后按 global.json 安装固定 SDK、准备隔离工具，然后运行 npm run check、构建和既有测试。新检查替代旧的仅五个安装脚本语法检查，覆盖全部自有 PowerShell 脚本。

完整矩阵的输入快照已扩展至发布/探针脚本、语言配置、CI、根安装入口及换行规则；检查结束核对期间是否有改动。格式规范、编译通过和自动测试证明的是受测版本及对应场景；实际 GitHub 运行、真实桌面点击、在线供应商、干净安装/升级仍需分别提供证据。

工具行为依据：[dotnet format 官方文档](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format)、[Ruff 官方说明](https://docs.astral.sh/ruff/linter/)、[PSScriptAnalyzer 官方说明](https://learn.microsoft.com/en-us/powershell/module/psscriptanalyzer/invoke-scriptanalyzer)。实际版本以仓库锁定文件和本轮本地检查为准。
