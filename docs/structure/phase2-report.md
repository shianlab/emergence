# 第二阶段：依赖与契约整理

日期：2026-11-17。对应七阶段方案第二阶段。以第一阶段冻结源码为起点，保留现有独立窗口、KIM、权限、工具回执、Code/Data 与视觉行为。

## 完整职责迁移

| 原依赖 | 现有归属及调用迁移 |
| --- | --- |
| CodeUnderstanding、CodeWorkHarness、DataFoundation 引用具体 SessionController | `core/adapters/capability-access.ts` 只描述 Harness 上下文、归属和即时权限/角色查询；CodeWorkHost 增加 home/toolVisible，DataHost 增加当前权限模式与确认操作。Controller 显式注入回调，适配器不接收整个 Controller |
| 核心 SessionPort 引用具体 CodeWorkHarness 并读取可变 CodeWorkflow | `core/application/code-evidence-port.ts` 定义任务执行所需证据契约。CodeWorkHarness.evidence 核对当前工作记录并产生结果快照，TaskExecution 只消费修复配对、检查结果和未验证变更标记 |
| Code/Data 从 app/instruction-files 获取基础文件工具 | 路径计算在 `platform/path-policy.ts`，内容哈希在 `platform/content-hash.ts`，有界 UTF-8 文件读取在 `platform/text-file.ts`。应用、能力、测试调用方全部迁移；原文件保留规则发现/作用域/呈现，不留转导出兼容壳 |
| planning 与 team 的类型循环 | `core/domain/intent.ts` 拥有意图分析及请求 schema；planning、team、工具注册与消息解析直接引用同一契约。原 schema 定义移除，历史数据形状不变 |
| 架构清单和检查可能各自推断依赖 | `scripts/architecture-graph.ts` 复用第一阶段解析与强连通组算法；inspect-architecture 和 check-architecture 共用。继续使用既有检查命令，不另建检查框架 |

新增端口不保存第二份会话、权限或规划状态。权限快照、约束、工具可见性和模式均在调用时读取；原 mount/register/dispose 路径不变。

证据核对原有的两次 10 秒读取期限、失败配对、最后 16 次检查投影、路径/命令限长和“未知不得通过”语义保持。错误仍交回任务执行层判定，未添加重试或新执行循环。

## 依赖对照

| 指标 | 第一阶段基线 | 第二阶段 |
| --- | ---: | ---: |
| Code/Data → app | 8 | 0 |
| core → 具体能力实现 | 1 | 0 |
| core → app | 0 | 0 |
| 值导入循环 | 0 | 0 |
| 纯领域 planning/team 循环 | 1 | 0 |
| 包含类型边、跨 app/core/能力层的循环组 | 1（33 文件） | 0 |

全图仍有两组内部类型耦合：app 内 8 个模块、core 内 20 个模块。它们是原大循环分离后的内部关系，未新增运行时循环。第三阶段处理旧协调器，第四阶段处理会话/规划职责；本阶段没有声称全仓库类型图已经无环。

架构检查禁止 core 依赖 app/能力实现、Code/Data 反向依赖 app、能力之间直接依赖，以及 platform 依赖业务层；规则同时覆盖类型与值导入。新增循环检查覆盖纯领域、能力、基础层和跨层循环。app/core 内部职责的进一步约束随第三、四阶段迁移接入，没有新增文件白名单或全局忽略。

## 验证记录

本次使用固定 Node 26.13.0。源码、测试和运行依赖在完整巡检期间冻结。

- 新增两项架构回归：类型导入/转导出/import-type 的循环，以及 require/动态导入/计算型导入与边界识别。
- 新增一项真实 Harness 能力回归：没有应用 Controller 时执行 Code 画像、Code 工作记录和 CSV SQL 求和；检查原输入未改，并验证计划模式拒绝保存口径。
- 原有测试仅迁移两个文件的基础工具导入，未删除断言、跳过测试或放宽通过阈值。
- 完整矩阵 41/41 通过，含 400/400 单元与 Harness 集成用例，失败/取消/跳过均为 0；类型、366 个文件的格式、161 个 TS 源文件的架构检查和本机构建通过。
- 本地模型路由/凭据轮换、Skills/MCP、HTTP 重试、故障恢复、16 会话并发与释放、18 项 TUI/UI 脚本和 13 项真实终端脚本全部通过。
- 矩阵执行期间源码变化为 0，package/lock 对齐；路径/哈希/有界文本读取函数体与第一阶段逐字比对一致。最终源码指纹为 `eac98f660140f30ba5aad8df358a37129af06b0402784663a0d677e56693049f`。
- 此处是真实 Harness/本地协议服务及终端测试，未重新调用付费模型、人工操作 Windows Forms、扫描线上依赖漏洞或测试发行安装；不将本地结果描述为这些额外验收。
- 原始证据在 `artifacts/structure-phase2-20261117/`：`architecture-before.json`、`architecture.json`、`full/inspection.json` 和 `phase-verification.json`。完整矩阵通过后没有修改受测源码。

新增能力测试编写时修正了夹具的 Context 释放入口，以及将“项目画像返回文件名”的错误预期改为实际语言计数；查询结果采用结构化值断言。未据此改动生产成功条件。

## 第三阶段交接

第二阶段已完成，可以按原方案进入第三阶段。本次已构建本机运行产物，没有发布新版本、推送 GitHub 或改写 1.00 标签。

R12 中核心对具体 CodeWorkHarness 的依赖已移除；WorkspacePort 的 team/协调器依赖继续按 R01–R03 和 R12 的第三阶段范围处理。退役协调代码尚未删除，本次未修改配置 schema、权限规则、模型、依赖版本、用户历史或凭据。

下一阶段按 [退役清单](phase1/retirement.md) 逐项提取单会话执行职责，迁移调用和历史读取，再解除旧协调器生产构造。现有产品继续保持窗口独立。
