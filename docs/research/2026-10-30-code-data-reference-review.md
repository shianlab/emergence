# Code 与数据分析参考资料研究记录

日期：2026-10-30。对象：用户放入 `参考/code`、`参考/data` 的六个 ZIP 快照，以及当前 Emergence 源码。配套执行方案见 [编程与数据能力增强方案](../code-data-enhancement-plan.md)。

## 研究范围与证据边界

六个压缩包均完成文件目录盘点，共 18,785 个非目录条目；记录包的 SHA-256，直接从 ZIP 读取，没有解包安装或运行第三方入口。对代码项目重点阅读运行循环、工具、上下文、子任务、编辑与测试；对数据项目遍历 31 个 Skill 的用途与流程、38 个 Python 脚本的函数和入口，重点核对计算脚本；另一个插件仓库盘点全部领域，重点研究 `data` 的 10 个 Skill，并抽查 `engineering`。未对图片、翻译、全部测试与所有非相关领域逐行审计。

这是架构研究和静态核对，不是六套产品的运行验收。源码中有测试，不等于本次运行通过。README 描述、实际实现和本研究提出的建议分别记录，不混为一谈。

证据文件：

- [完整文件与压缩包指纹清单](../../artifacts/reference-review-2026-10-30/inventory.json)
- [显式阅读与片段检索记录](../../artifacts/reference-review-2026-10-30/inspection-log.jsonl)（辅助记录，不代表每条输出均已完整阅读）
- [数据脚本函数与入口映射](../../artifacts/reference-review-2026-10-30/data-script-map.json)

以下源码位置均为对应 ZIP 内去掉顶层目录后的成员路径。分支名不等于发布版本；ZIP 没有 Git 历史，不能从文件名推断 commit。

## 六个项目分别学什么

| 参考包 | 文件数 | 值得借鉴 | 接入判断 |
|---|---:|---|---|
| `code/claude-code-main.zip` | 1,473 | 生命周期拦截、权限配置、插件边界和面向使用者的工作流 | 此包不是完整核心执行器源码；根许可证写明 All rights reserved，不能按 MIT 项目整包搬入 |
| `code/kimi-code-main.zip` | 4,554 | Agent/Session/Workspace 生命周期分层，子任务取消与部分结果，压缩后的恢复指针，按需工具加载 | 最值得研究执行工程；保留 Emergence 的调度和权限所有权，不引入第二套 Agent 主循环 |
| `code/MiMo-Code-main.zip` | 2,060 | 分层任务进展、检查点校验、预算化上下文重建、Notebook 定位编辑 | 以增量能力为主；与 OpenCode 有继承关系，不应当作完全独立架构重复吸收 |
| `code/opencode-dev.zip` | 9,235 | 工具插件边界、文件修改锁、可分页读取、结构化结果、压缩与快照接口 | `dev` 快照部分连接仍为 TODO；按实现和测试借鉴，不能照功能清单推定全部可用 |
| `data/data-analytics-skills-main.zip` | 178 | 数据质量、口径、分析、报告、交付复核的完整方法覆盖 | 31 个方法可归并为内置分析流程；脚本质量不一致，需筛选和重写 |
| `data/knowledge-work-plugins-main.zip` | 1,285 | 按问题复杂度选择分析路径、企业数据上下文、SQL 方言、结果验证、图表交付 | `data` 部分主要是方法和示例；连接器不等于已连通的数据运行时 |

许可证文件观察：Kimi、OpenCode、Data Analytics 根 LICENSE 为 MIT；MiMo 根 LICENSE 为 MIT 且另附 `USE_RESTRICTIONS.md`；Knowledge Work 根 LICENSE 为 Apache-2.0，`data` 另有 LICENSE。后续实际复用具体文件时逐项保留归属与适用声明，不能用根许可证替代所有子资产核对。本次没有复制第三方实现到产品。

## Code 项目核对结果

### Claude Code：学公开接口，不假装拿到了核心源码

已读 `README.md`、`LICENSE.md`、`plugins/README.md`、`examples/hooks/bash_command_validator_example.py`、`examples/settings/settings-strict.json`、`settings-bash-sandbox.json`。

Hook 示例展示了调用前读取结构化输入、返回阻止原因的机制；它的正则主要提示将 grep/find 换为 rg，并非通用 Shell 安全解析器。配置示例区分审批和沙箱限制，但仅复制配置不能让 Emergence 获得对应隔离实现。

借鉴：代码任务按照了解项目、执行变更、验证结果组织；工具调用前后有统一扩展点；输出可审查。现有权限与执行中间件已经承担部分职责，优先增强已有入口。

### Kimi Code：生命周期、上下文恢复和工具选择

关键位置：

- `packages/agent-core-v2/src/agent/loop/loop.ts`：运行、工具调用、重试、队列及活动状态的结构化接口。
- `.../agent/loop/machine/engine.ts`、`tools.ts`：事件、工具批次、取消与回执适配。
- `.../session/subagent/runAgentTurn.ts`：子任务启动、运行结果收集、取消信号衔接。
- `.../session/subagent/spawn.ts`：fork/resume/model 的兼容性限制，避免含混的上下文继承。
- `.../agent/fullCompaction/strategy.ts`、`contextRecovery.ts`：按模型上下文计算压缩，提供历史 journal 与区段定位信息。
- `.../agent/tools/select-tools/selectToolsTool.ts`：只加载已公告工具名，区分不可用、被策略拒绝、重复失败，阻止无限猜名称。
- `.../agent/tools/edit/editTool.ts`：声明文件读写访问，执行前再次核对计划/环境绑定。
- `.../app/edit/fileEditService.ts`：文本编辑服务与工具审批/环境责任分离。

对应抽查测试：`test/agent/fullCompaction/strategy.test.ts`、`test/agent/task/subagent-timeout.test.ts`、`test/app/edit/tools/edit.test.ts`。特别有价值的是超时后交还部分输出、保留近期用户消息、审批显示编辑前后内容的验证思路。

对 Emergence 的增量：按需暴露领域工具；压缩保留目标、约束、产物和证据定位；运行状态使用真实事件；将失败原因反馈给规划器。不要照搬固定的 50,000 token 预留或整个依赖注入框架，应服从当前模型预算和项目规模。

### MiMo Code：任务进展与检查点，而非另造一套编排

README 与根 LICENSE 均体现 OpenCode 来源。重点阅读：

- `packages/cli/src/session/checkpoint.ts`：重建时组合检查点、记忆与近期消息；有等待上限及失败回退设计。
- `.../checkpoint-validator.ts`：必需章节、预算、进展等校验，不仅相信模型写出的摘要。
- `.../checkpoint-progress-reconcile.ts`：比较任务 progress 的 written-at 与已合并水位，增量整理子任务进展。
- `.../checkpoint-context.ts`：session/actor 作用域隔离并复制返回状态。
- `.../tool/edit.ts`、`apply_patch.ts`：文件级锁、写入边界与诊断相关连接。
- `.../tool/notebook-edit.ts`：使用 cell id 做 replace/insert/delete，而非把 ipynb 当普通大文本盲替换。
- `test/session/checkpoint-watermark-transactional.test.ts` 等测试目录：可借鉴水位推进、失败恢复的验收场景；本次未运行。

对 Emergence 的增量：在现有任务和执行日志上生成“当前项目理解、未解决失败、已验收产物、数据口径”摘要，带版本与证据索引；不要再建立 MEMORY.md、checkpoint.md 与现有 SQLite 各自决定任务状态的多份真相。Notebook 编辑也不等于 Notebook 计算内核，后者需独立实现和验收。

### OpenCode dev：工具工程有价值，文档与连接状态需分开看

这个快照的主要核心在 `packages/core`，不是旧布局的 `packages/opencode`。

- `src/tool/plugin/edit.ts:315`、`patch.ts:304`：文件修改通过 `fileMutation.withLock`。
- `src/tool/plugin/read.ts:189`、`:202`：截断后返回后续 offset，便于继续读取。
- `src/session/compaction.ts`：自动/手动/overflow 分支、模型预算和重试处理。
- `src/snapshot.ts`：Location 作用域、内容寻址快照及 best-effort 失败边界。
- `test/tool-edit.test.ts`：保留 CRLF、不应把无变化编辑报告为成功等具体场景。

特别核实：`src/tool/plugin/edit.ts:202–205` 仍有 watcher、snapshots/undo、LSP integration 的 TODO。独立 snapshot 服务存在，不代表该编辑入口已全部接通。包内 `packages/web/src/content/docs/lsp.mdx:51,70–72` 也明确默认关闭 LSP、说明内存和同步成本。

对 Emergence 的增量：先形成明确的构建、类型检查、测试反馈；符号检索和 LSP 按项目需要增量接入。不要一开始启动所有语言服务器，也不要承诺 Shell 或外部工具修改均可一键回滚。

## 数据参考包：31 个方法的吸收地图

| 类别 | 已浏览的方法 | 内置方向 |
|---|---|---|
| 质量与探索（3） | data-quality-audit、programmatic-eda、query-validation | 数据画像、质量检查、SQL 校验 |
| 知识与口径（7） | analysis-assumptions-log、analysis-documentation、data-catalog-entry、metric-reconciliation、schema-mapper、semantic-model-builder、sql-to-business-logic | 数据集契约、指标定义、假设和来源记录 |
| 分析（7） | ab-test-analysis、business-metrics-calculator、cohort-analysis、funnel-analysis、root-cause-investigation、segmentation-analysis、time-series-analysis | 有输入前提和验收样例的分析方法 |
| 图表与表达（5） | dashboard-specification、data-narrative-builder、executive-summary-generator、insight-synthesis、visualization-builder | 图表、摘要和报告生成 |
| 交付复核（5） | analysis-qa-checklist、impact-quantification、methodology-explainer、stakeholder-requirements-gathering、technical-to-business-translator | 口径澄清、结论强度、复核与中文解释 |
| 工作流（4） | analysis-planning、analysis-retrospective、context-packager、peer-review-template | 接入已有 KIM 规划、审查、记忆，不另造调度器 |

有 38 个 Python 脚本和一个 SQL 模板（不含根目录的校验脚本）；不能概括为“全是提示词”，也不能把它们都当作成熟计算模块。`validate_skills.py` 只验证 Skill 文件、frontmatter 与必需标题，不验证数值正确性。

### 已确认的静态问题与接入限制

| 位置 | 观察到的实现 | 对方案的影响 |
|---|---|---|
| `03-data-analysis-investigation/ab-test-analysis/scripts/ab_test_analyzer.py:136–169` | 定义了 main 参数解析，但 `__main__` 直接跑固定演示；main 未被调用；文档所列 `--csv`、`--check-srm` 也未在 parser 注册 | 不能把此 CLI 当真实数据分析入口。需要正式参数、结构化输出及非演示样例 |
| 同文件 `:147`、`:94–98` | `all(...)` 把合法的零转化数当缺参；非表内 alpha 静默用 1.960 | 输入边界和统计参数必须严格校验，使用可靠统计函数，未知参数不能悄悄替代 |
| `funnel-analysis/scripts/funnel_analyzer.py:148–149` | 入口固定 `_demo()`；函数处理汇总 steps/counts | 没有实现 Skill 描述的用户事件排序、完成时间窗、耗时分位数，不能据此宣称完整漏斗分析 |
| `01-data-quality-validation/query-validation/scripts/cardinality_estimator.py:17–40` | 多对多估计为 `L*R/max(L,R)`；正数时等于 min(L,R)，使 `est > 2*L` 的 HIGH 分支不可达；双零会除零 | 改为真实键频率、唯一性、关联前后计数验证；未知分布明确未知 |
| `cohort-analysis/scripts/retention_matrix.py:18–34` | 分母取 period 0 实际出现的活跃用户 | 仅适合特定口径；若需求是注册 cohort，需要完整注册人口，不能漏掉首期未活跃者 |
| `05-stakeholder-communication/impact-quantification/scripts/confidence_interval.py:17–43` | 使用人工比例档位生成低/中/高区间 | 可作为情景估算，不能冒充由样本计算的统计置信区间 |
| `technical-to-business-translator/SKILL.md:15` | 将 p<0.05 示范解释为“95% 确信不是随机” | 不应吸收该表述；中文报告保留检验假设、效应量和不确定性，避免统计含义改变 |
| `programmatic-eda/scripts/data_overview.py:38–44` | pandas 全量载入文件；没有在此入口做大文件预检/分块预算 | 前置文件大小、格式与编码检查；大表选择列扫描/分块，预览与全量结论分开 |

这些是源码可核对的问题，不是本次对第三方程序做完动态测试后的缺陷清单。后续要引入的实现必须经过独立测试；不修改原 ZIP，也不依赖其演示入口。

### Knowledge Work 的 data 插件

10 个方法均已浏览入口和结构：`analyze`、`explore-data`、`write-query`、`sql-queries`、`create-viz`、`data-visualization`、`build-dashboard`、`statistical-analysis`、`validate-data`、`data-context-extractor`。重要价值是从业务问题到交付的连贯流程。

- `analyze/SKILL.md:21–87` 分快速回答、完整分析、正式报告，交付前检查行数、空值、量级、时间连续性和聚合一致性。适合给 KIM 增加分析深度选择，避免小问题跑一整套大流程。
- `validate-data/SKILL.md` 有分母、重复关联、部分时间段、加权均值、选择偏差及复算清单。应转成可执行断言加人工解释；不能把“收入非负”“百分比 0–100”一律硬编码，退款净额和增长率等有例外。
- `data-context-extractor` 关注公司术语、指标定义、表连接与常用查询。Emergence 应保存项目级版本化数据知识，不必生成又一套用户手动加载的 Skill。
- `build-dashboard` 提供较长 HTML/JS 示例；应提取图表选择、过滤与数据交付方式，不搬视觉主题。演示数据必须明显标记，不能因缺数据而冒充实算。
- `data/.mcp.json` 中 Snowflake、Databricks 的 URL 为空；`CONNECTORS.md` 也标记 placeholder。此包没有提供通用数据运行引擎，`data` 内唯一 Python 文件是打包数据 Skill 的脚本。

## Emergence 当前能力与真实缺口

| 领域 | 当前证据 | 需要补强 |
|---|---|---|
| 自动意图与编排 | `src/core/adapters/planning.ts`、`src/core/domain/planning.ts`、`src/app/team-coordinator.ts`、`src/core/application/work-allocation.ts` | 增加 code/data/mixed 领域事实与输入前提，不以关键词路由冒充业务理解 |
| 主副窗口协作 | `src/app/collaboration.ts`、`team-followthrough.ts`；已有依赖、回执、复核和产物指纹 | 让计划理解数据集、指标、代码改动、验证结果，扩展已有角色与能力匹配 |
| 上下文与记忆 | 上游 compaction 包与 `tests/core-resilience.test.ts`；`src/core/adapters/memory.ts`、`storage/memory-store.ts` | 在现有机制中保留领域摘要、未解决问题与来源指针，不重复造压缩和记忆引擎 |
| 文件编辑 | 已安装 `dsh-tool-str-replace-editor/lib/index.js:159–220` 存在 replaceIfVersion；已有依赖产物版本验证 | 先验证活动工具链覆盖范围，再补跨文件变更集、验证诊断、冲突回退边界，不能宣称从零加版本检查 |
| 证据验收 | `src/core/domain/assurance.ts`、`application/assurance.ts`：文件哈希、命令退出码、独立验收 | 从 read/command/other 扩展到带输入版本与口径的数值/诊断证据 |
| 领域执行 | 对 src/tests 检索未发现专用 Python 数据会话、DuckDB 数据服务或代码 LSP 管理实现 | 通用 Shell 可跑脚本；仍需内置领域运行时、数据类型、资源预算与错误解释 |
| 外部连接 | `src/app/capabilities.ts` 已集中管理 MCP 生命周期与状态 | 增加数据连接语义、只读策略、schema/方言/扫描预算。MCP 注册不能视为数据源已验证 |

一个必须先处理的接入点：`src/core/application/assurance.ts:108` 跳过 `emergence_` 前缀工具，且读取/命令工具按名称分类；`permissions.ts` 也有已知工具集合；`work-allocation.ts` 只将少数文件工具视作可按路径约束的任务。直接新增 `emergence_data_*` 并注册，会缺少正确的证据分类、审批语义和并行范围。需要由宿主提供统一能力描述并逐步接入已有中间件；不能让模型或外部工具自称只读就获得权限。

## 外部技术核实

只用于验证方案边界，不替代上述本地快照：

- Python `venv` 提供解释器/依赖环境分离，不能由此声称有操作系统级沙箱：[官方文档](https://docs.python.org/3/library/venv.html)。
- DuckDB 对外部文件、扩展和配置有独立控制；仅以 SQL 的 SELECT 开头判断只读不够：[Securing DuckDB](https://duckdb.org/docs/2.0/operations_manual/securing_duckdb/overview)。
- 统计实现应使用明确参数与适用前提的函数，例如 SciPy 的 Welch t 检验需 `equal_var=False`，并处理 NaN 与置信区间：[ttest_ind](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html)。

研究结论：优先吸收执行与验证机制、可追溯上下文和数据分析方法；在 Emergence 自己的执行链内实现领域能力，并用固定样例检验。仓库数量与 Skill 数量不能作为能力完成度指标。
