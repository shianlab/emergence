# 第六阶段：统一代码规范与自动检查

日期：2026-11-17。对应七阶段方案第六阶段，以第五阶段冻结输入及本轮排版前快照为基线。保持当前独立多窗口、TUI 视觉、模型配置与运行目标。

## 本轮完成内容

1. **统一源码范围。** source-files 为四种语言提供统一发现入口；明确维护根目录、根安装脚本及三个生成 TS 文件排除项。第三方、生成资产、依赖、构建输出和历史副本不被格式器重写。
2. **固定多语言工具。** 保留现有 Prettier/TypeScript；加入固定 Ruff 0.14.10、SDK 8.0.426 自带 C# 格式器、PSScriptAnalyzer 1.24.0。Ruff 的 Windows x64 wheel 带哈希，SDK 禁止自动滚动，PowerShell 模块只保存到项目开发工具目录。
3. **检查与修复分开。** check 命令只读；format 仅调整排版。Python 的导入、函数与变量整理单独记录，不通过自动 unsafe-fixes 或忽略规则消除问题。
4. **C# 可读性与兼容。** 展开原有密集的语句/代码块，保留所有语法标记；静态入口以 C# 5、warning level 4 和警告视为错误编译全部自有 C#。现有 Windows Forms/.NET Framework 4.8 构建与用户运行依赖不变。
5. **PowerShell 规范。** 全部自有脚本及规范配置进入 5.1 语法和规则检查，统一 CRLF、UTF-8 BOM，确保中文在旧版 Windows PowerShell 下可读。
6. **统一命令与 CI。** check:style 和 format 扩展至四种语言；check-orchestration.ts 更名为 check-typescript.ts，内部调用全部迁移。GitHub Windows CI 使用同一工具准备与检查命令，替代原来只解析五个安装脚本的单独步骤。
7. **维护规则落地。** 更新 CONTRIBUTING、EMERGENCE 指引和编码规范，修正仍指向 task-coordinator、旧历史宿主/脚本的过期说明。复杂方法、唯一状态、异步错误、资源释放、类型和测试审查有明确约定。

详见 [编码规范与检查入口](coding-standards.md)。自有源码没有添加新的 suppress/ignore 来规避检查；未修改 npm 运行依赖、package-lock、版本、发布标签、用户配置或密钥。

## 静态问题与整理依据

Python 初次规则检查发现 12 项问题：未用的 math/sys/ctypes 导入、多导入写在同一行、三个赋值形式的 lambda，以及数据对账计数变量 `l`。清理无用导入、拆开导入语句，将 lambda 改为等价局部函数，对账计数改名为 left_count/right_count。没有改变数据查询约束、统计公式、文件边界或输出字段。

排版与代码整理分批保留：

- C# 9 个文件经 Roslyn 对比排版前后的语法标记类型与文本，完全一致。
- Python 8 个文件的纯排版快照经 AST 对比，完全一致；随后才应用上述独立静态问题修正。
- 原有 PowerShell 11 个脚本经词法标记对比，在忽略注释/换行标记并统一 CRLF/LF 后一致；另有两个新检查/准备脚本和一个规则文件纳入检查。
- `before/`、`formatted/` 和 `format-only.patch` 保留排版批次，`reviewed/` 与 `python-cleanup.patch` 单独保存随后代码整理的差异。

当前工作树仍含前五阶段未提交改动。本轮没有把这些工作与格式变更混成一次 Git 提交，也没有覆盖或重置已有工作。正式提交时应按维护规范分别提交已有工作、纯格式批次和检查/代码调整；本地证据提供了拆分依据。

迁移清单记录 32 个已知输入修改、10 个新增文件、1 个旧入口退出；另外 22 个既有文件因检查范围扩展首次纳入清单，不能把它们误称为本轮新增代码。根换行/忽略规则与 CI 的变化在对应文件可审查。清单中的 vendor 文件变化为 0。详见 [第六阶段迁移清单](phase6-migration-catalog.json)。

## 验证过程与限制

检查器采用真实失败返回值：构造临时 Python 未定义变量、C# 缺失方法以及 PowerShell Invoke-Expression 输入，分别产生 F821、CS0103、PSAvoidUsingInvokeExpression，三项都被拒绝；检查完删除这些临时输入，没有执行其中的脚本内容。

工具接入时修正了实际遇到的兼容问题：dotnet format 的 folder 模式不能与 no-restore 同用；PowerShell 5.1 的数组/路径转换需要明确处理；格式器遇到混合换行及行尾空白需要规范化；准备模块改用 PowerShell 7，实际脚本检查继续使用 5.1。最终工具准备命令在本机已成功执行。

一轮中间矩阵因扩展输入哈希范围而主动停止，保留 interim-input-scope.log。最终矩阵从头重跑，纳入 release、probes、quality、根安装脚本、CI 和换行/忽略规则；不拼接不同版本结果。

第六阶段已完成。最终固定版本使用 Node 26.13.0，结果如下：

- 完整矩阵 **44/44** 通过，比上一阶段增加 Python、C#、PowerShell 三项检查；单元与 Harness 集成 **326/326** 通过，失败、取消和跳过均为 0。
- 339 个 TS 文件格式、严格类型、171 个 TS 源文件架构检查通过；9 个 C#、8 个 Python、14 个 PowerShell 文件的对应检查通过。
- 完整 CLI/Harness/原生工具构建，模型配置/密钥轮换/窗口分配，Skills/MCP 与工具协议，故障恢复及 16 会话并发释放通过。
- 原有 18 项 OpenTUI/UI 脚本、13 项后台真实终端脚本均通过，没有减少测试或放宽成功条件。
- 安全扫描未发现已保存凭据的明文匹配；npm audit 报告漏洞为 0。此结果不代表已扫描所有未知秘密或所有非 npm 工具的安全风险。
- 矩阵期间输入变化为 0，验收后逐项核对源码与扩展输入哈希一致，package/lock 对齐，`git diff --check` 通过。

源文件仍为 174 个 TS/Python 文件，26,252 行；行数增长主要来自展开排版，不以增长或减少作为质量结论。运行值导入循环及 core 反向依赖 app 为 0；两个既有内部类型耦合组未增加。

源码指纹：`950ae717c76280059812f9ca750c874f9f21c3e770276e56f46f6fd1ecb58386`。检查输入指纹：`da5243b36e775765d1c0e61f5cecbb67a4c37ea0b7cd830949c68eb9b1e7acf8`。

证据位于 `artifacts/structure-phase6-20261117/`：accepted/inspection.json、phase-verification.json、architecture.json、security/security.json、gate-proof.json、三份 format-proof.json、migration-catalog.json 及分批差异。最终矩阵启动后未再修改受测源码或检查配置，之后只整理文档和证据。

## 后续范围

这轮建立的是持续约束，并不表示所有方法已经足够短、所有复杂逻辑已经消失或程序没有任何未知缺陷。第五阶段保留的工作台组装职责和两个内部类型耦合组继续如实记录，不能靠机械拆文件或扩大忽略范围解决。

本轮没有控制桌面、点击原生窗口、运行付费模型、安装用户发行包或推送 GitHub。CI 配置已经写好，本地同入口验收与 GitHub 上实际执行是两类证据；后者待推送后确认。第七阶段负责最终结构复审、真实环境与候选包验收。
