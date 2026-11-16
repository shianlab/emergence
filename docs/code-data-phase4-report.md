# Code / Data 第四阶段：数据接入与执行基础

日期：2026-10-31。当前交付面向 Windows 本机调试，不涉及安装包或发布。

## 本机已实现

- 原生 `emergence_data_profile` 与 `emergence_data_query` 接入现有会话、KIM 提示、读取权限、项目指引和真实输入版本证据。自然语言数据任务无需安装或点名 Skill。
- CSV/TSV、XLSX、Parquet 读取；返回行列数、缺失、不同值数、重复行、候选键、类型线索、ISO 日期范围和样本。明确为预算内完整扫描，超限直接拒绝。
- 数据保存为文本进行传递，保留 ID 前导零、长整数、Decimal 和日期表示；SQL 运算要求显式 CAST。空字段按缺失处理，未擅自填零或转换模糊日期。
- Excel 多工作表先返回工作表列表；不擅自合并。公式只读取文件保存的缓存，不运行宏或重新计算；缺缓存会警告并阻止 SQL 汇总，已有缓存也不能保证最新。
- SQL 只允许解析器认定的单条 SELECT/WITH，在固定内存表 `data` 上执行。关闭外部访问及扩展自动安装/加载。不是靠 SELECT 前缀判断安全；COPY、写入、多语句、外部文件和网络读取均有拒绝测试。
- 项目专用 `.data-venv`：Python 3.14.3，DuckDB 1.4.3、openpyxl 3.1.5、et-xmlfile 2.0.0。依赖固定在 `emergence/src/domains/data/requirements.txt`，重建命令为 `powershell -File emergence/scripts/setup-data.ps1`。现已在本机创建，pip check 无依赖冲突。
- 执行固定 Python 工作脚本；不执行模型提供的任意 Python。任意分析脚本仍需经过已有 Shell 工具和审批，不将 venv 宣称为任意代码沙箱。后续分析方法将在第五阶段增加。

## 边界与产物

源文件须位于当前工作目录内，为不超过 8 MiB 的普通文件。输入只读，执行使用专属快照；结束前重新核对源文件 hash、路径与权限，变化则结果失效。

每次运行在 Emergence home 的 `core/data-runs/<UUID>/` 保存输入快照、request.json、result.json 和 manifest.json。记录源码/SQL/参数/输入/输出 hash、运行环境、执行状态和预算。失败或取消不会返回成功工具结果；不能把上次分析状态当成仍在运行的 Python 变量。

预算：最多 10,000 行、128 列、100,000 个单元格，单元格 4,000 字符；Excel 解压总量 64 MiB；SQL 输出 100 行；进程输出 512 KB；模型摘要 24 KB；执行超时 30 秒。DuckDB 使用单线程和 256 MB 引擎内存设置，但这不是 Python 进程总 RSS 的操作系统硬限制。超限拒绝或明确省略预览，不把样本算成全量。

Windows 取消/超时调用进程树终止并等待工作进程退出。专项测试启动了真实子进程，通过 PID 检查确认父子进程不再存活。原始数据未被覆盖，不做任意 Shell 副作用回滚。

## 验证与真实模型试用

专项测试：`emergence/tests/data-foundation.test.ts`。覆盖实际 CSV 汇总、中文/前导零/长整数、坏日期文本、缺失与重复、真实多工作表 XLSX、缺公式缓存、真实 Parquet、坏行/空输入/GB18030、危险 SQL、路径越界、权限变化、预算、超时/取消/缺解释器，以及真实 Harness 计划模式工具调用。

全量巡检记录位于 `artifacts/code-data-phase4/inspection.json`，包含类型检查、构建、全部单元/Harness 测试、工具/Skill/MCP 协议、故障恢复、审批交互和终端回归；同时检查 TS、Python、依赖清单等源文件是否在运行期间变化。

实网试用脚本与记录位于 `artifacts/code-data-phase4/live.mts` 和 `live.json`。第一次试用发现模型误把文件名写进 FROM，安全执行器拒绝了外部访问；已补充结构化 sqlTable/sqlExample 和可纠正的错误说明，未开放文件访问来迁就错误 SQL。

## 尚未验收的部分

**没有配置远程 SQL 数据源，本次没有新增专用远程 SQL 适配器，也没有完成远程 schema/查询/超时/断连验收。** 已有通用 MCP 工具链仍然保留并参加回归；它不等同于远程数据源已验证。工具明确报告远程未配置，不注入演示数据冒充真实数据。第四阶段本机能力已交付，远程部分仍是待接入项。

本次不覆盖任意规模数据、完整统计分析方法、图表报告交付和多真实模型数据团队基准；这些也不能从一个汇总样例推断为已完成。

参考依据：[DuckDB Python API](https://duckdb.org/docs/stable/clients/python/reference/) 用于语句解析与执行接口；[openpyxl 官方教程](https://openpyxl.readthedocs.io/en/stable/tutorial.html) 说明 data_only 读取已有公式缓存。实际行为以固定版本的本地反例测试为准。

## 使用

重启 `emergence`，在数据所在项目目录输入，例如：

> 检查 sales.csv 的数据质量，保留 ID 前导零，真实计算 amount 总额，单独说明缺失值，不修改原文件。

工作表或编码不明确时根据工具结果选择。原有 TUI 视觉和模型配置插件保持现有设计。

最终实网样例使用 `glm-coding / glm-5.3-flash`，约 56 秒完成画像和真实 SQL 汇总，结果为 20，原始 CSV 内容不变。该实网运行位于表名提示修正之后；随后仅统一了失败清单的保存位置，最终版本通过本地回归。成功样例不是远程连接或任意 Python 沙箱的验证。

补充边界：Excel 读取存储值，不重建数字格式产生的显示补零；数字单元格在 Excel 保存时已丢失的精度不能恢复。原本保存为文本的 ID 和长整数保持文本。通用自动断言不能替代业务口径确认。

最终巡检结果：8 类检查通过；完整单元/Harness 测试集 202/202 通过。最终构建首轮出现一次旧测试清理临时目录的 Windows EBUSY，未删除或跳过测试；以并发 4 完整重跑全部 202 项后通过。两次运行日志和初始结果均保留，inspection.json 中有 attempts 记录；重跑后逐文件核对 sourceHashes 无变化。依赖检查 `pip check` 通过。
