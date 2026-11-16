# 需求理解与后台资料

日期：2026-10-30。

## 用户反馈与原因

「运行上下文」提供当前目录等运行约束；「项目指引」提供 EMERGENCE.md 等项目和个人规则；「技能目录」提供可发现的外部技能。这些是真实模型输入，不是助手回答。此前每条后台记录都作为独立消息显示，即使折叠仍占据正文。

原生 KIM 治理入口已经有关键词初筛、模型目标分析和执行前门禁，但分析只有 objective/reason/route，没有完整呈现用户需求；初筛也不能等同于语义理解。这次补充真实分析内容和可见反馈，不把状态文字当作分析证据。

## 实现

- 三种后台记录仍保存在 Session、模型上下文及导出历史中，默认不显示各自消息行。一个「背景资料」入口和 `/view context` 控制查看；技能实际调用、协作回执等仍正常显示。切换会话重置收起状态。
- 原生 `emergence_analyze` 增加 intent（discuss/execute/clarify）、constraints、acceptance、questions。旧分析记录仍可读取。字段经过 schema 校验后才更新状态；questions 限于必须由用户决定的阻塞问题。
- 任务、需求和想法的入口要求模型先整理目标、约束、验收、关键问题；简单事实问答不强制分析。工具成功回执渲染为中文「需求理解」，失败、运行中或非法结果不会显示为已完成理解。摘要有长度限制，详情保留完整参数和结果。
- discuss、clarify 或未解决 questions 阻止主控的实施工具和计划执行。`readyPlan()` 也检查这一条件，手工运行计划不能绕过。后续用户输入重新分析；现有委派任务仍继承主控契约。
- 不改写用户原话，不自动安装或禁用外部 Skills，不修改用户真实配置，不扩充第二套任务调度器。

## 验证

- 全量巡检：118/118 单元及 Harness 集成测试通过；13 组检查全部退出成功，涵盖类型检查、本机构建、原生 TUI、Windows 输入与审批。共享目录内的模型配置及 UI 文件在巡检期间被其他工作更新，最终记录保留 `passed=false` 和 `changedDuringRun`，不能把它宣称为整仓同一版本验收通过；详情见 `artifacts/runtime-team/inspection.json`。本轮相关功能另有下述独立测试证据。
- `tests/runtime-intake.test.ts`：6 项通过，含讨论/澄清下实际写入被拒、手工计划执行被拒、后续实施恢复，以及原有语义升级/关键词漏判/主控派工。
- `tests/tui-intent.ts`：原生 OpenTUI 渲染与鼠标测试通过。默认隐藏、点击展开、命令收起、历史无损、窄屏全部字段可见、切换会话隔离，错误回执不伪装成功。证据：`artifacts/intent-context/tui.json`。
- `tests/tui-phase2.ts`：Markdown、工具详情、流式消息、滚动位置与审批恢复等 12 组检查通过。
- `tests/runtime-live.ts --live`：使用实际配置的 deepseek-flash，在隔离临时目录测试。自然讨论请求未点名 KIM 或工具，自动调用 emergence_analyze，记录 discuss、目标、约束和验收；文件未修改。随后独立实施请求完成分析、实际编辑与读回核对。证据：`artifacts/intent-context/live.json` 和 `artifacts/runtime-team/live.json`。

## 边界

语义分析由当前模型完成，并非每次输入额外调用一个独立模型。程序能检查结构与执行边界，不能保证对所有自然语言都理解正确，也不宣称已经完整移植全部上游 Meta_Kim 行为。用户可从「需求理解」看到模型如何理解并及时纠正。当前原生核心承接范围继续以 [能力台账](meta-kim-capability-map.md) 为准。
