# 会话与规划维护指南

本页描述第四阶段后的当前结构。Harness 仍拥有会话历史、工具和 Agent 循环；TaskEngine、TaskLifecycle 与 ExecutionJournal 仍负责单会话任务和执行事实。

## 状态归属

| 状态或职责 | 唯一拥有者 | 对外接口及限制 |
| --- | --- | --- |
| 根会话句柄、子代理租约、切换/取消/关闭中的操作 | `app/session-lifecycle.ts` 的 SessionLifecycle | `open/cancel/close`；`current/closed/switching` 为查询。会话切换未结束前，拒绝新的切换与提交 |
| 当前权限模式、版本、精确授权、拒绝记录、运行中工具计数 | `app/session-permissions.ts` 的 SessionPermissions | `setPermissionMode/invalidatePermissions/confirmDecision/writeWithPermission`；通过有限宿主回调获取项目、规划约束和真实工具活动 |
| 待回答交互、版本、答复及取消 | 每个控制器唯一的 InteractionQueue | 审批和问题共用此队列；焦点、窗口布局不能批准请求；答复继续核对会话、代理、调用、权限与任务身份 |
| 问题与澄清的 Harness 接入 | `app/session-questions.ts` | 问题答复交给队列，真实澄清交给原请求捕获的回调；不直接修改需求或权限 |
| 增量文本、消息、Tokens、流式输出及工具显示 | `app/session-presentation.ts` 的 SessionPresentation | 查询展示缓存；不持久化执行状态，不决定任务是否成功；RunDiagnostics 继续拥有运行预算和诊断 |
| 用户来源、需求、分析、计划、修订/读取预算、回执、预览输入 | `core/application/planning-requests.ts` 的 PlanningRequests | 私有状态与串行 PlanStore 写入；admit/analyze/revise/beginRead/recordReceipt 等操作。view、snapshot、intake 和返回回执不暴露内部可变引用 |
| 工具、模型、Skill、MCP 和窗口绑定的观测 | `planning-inventory.ts` | 只生成实际能力快照并检查查询期间绑定变化；清单不授予执行权，工具解析视图总在 finally 中释放 |
| 需求契约与计划准入 | `planning-admission.ts` | 检查预算、需求完整性、能力和绑定；操作临时检查草案，由请求拥有者核对原请求后提交 |
| 工具调用的规划限制 | `planning-policy.ts` | 根据显式事实返回限制原因；不能发起执行或写入状态；权限层仍保留最终限制 |
| 需求卡、规划说明和模型上下文 | `planning-presentation.ts` | 纯数据投影，按上下文预算保留完整需求来源，不改请求或计划 |

`SessionController` 是组装与命令入口；`CorePlanning` 是规划各模块的组装入口。二者不再保留上述职责的第二套实现。`session-config.ts` 与 `session-model.ts` 分别定义启动契约及历史兼容检查；调用者直接导入定义模块。

## 会话切换与资源收尾

1. 切换前检查关闭、切换、运行中任务与规则初始化；同一时间只接受一个切换。
2. 新候选取得独占租约并创建/恢复，检查历史和模型能力，再绑定诊断、记忆、Code/Data 和 KIM。旧会话在候选就绪前保留。
3. 候选绑定或保存最近会话失败时，恢复旧句柄与配置，尝试恢复绑定，并释放候选及其租约；不吞掉收尾异常。
4. 候选成功后释放旧句柄与租约。授权撤销和交互取消仍通过原来唯一的队列和权限模块处理。
5. 关闭立即阻止新操作并取消交互，等待进行中的切换结束；共享一次取消操作并等待 Agent 空闲，然后结算规则初始化、刷新历史、释放根 Agent。
6. 规划写入、KIM、诊断、权限和应用订阅逐项收尾；即使一项失败，仍继续其他项。等待子代理租约作业并释放租约，卸载所有订阅，最后汇总错误。重复关闭复用同一个 Promise；取消操作结算后再通知调用方忙碌状态已结束。

异步模型查询返回后重新核对会话身份和忙碌状态，不能将旧选择应用到后来打开的会话。资源模块只接收所需回调，不反向导入 SessionController。

## 请求与规划的一致性

- 只有已接纳用户消息或当前单会话任务消息可以更新来源；工具回复不能伪造用户授权。预览输入仅影响工具激活和上下文，正式接纳仍由 Harness pre-step 结果决定。
- 计划检查基于独立草案。提交时校验原 Agent、请求对象、目录范围与关闭状态；旧检查成功或失败，都不能覆盖或阻塞后来接纳的新请求。
- 修订预算由请求拥有者扣减，失败不会返还；同一运行状态不并发检查两份修订。读取预算由同一拥有者维护，计划检查期间完成的读取和成功回执不会被草案覆盖。
- 工具观察记录绑定请求来源和目录范围；迟到的旧请求回执不写入新任务证据。最终有效回执仍要求真实工具结果成功，并经过既有结果语义检查。
- 可执行计划先经过完整需求/绑定复验；执行回执只写回原请求，不能因当前窗口切换而附加到另一个请求。执行事实本身仍以 TaskEngine/Journal 为准。
- `/plan`、能力清单、需求卡和调用结果均读取分离的数据副本。外部修改这些对象不会改变实际计划；损坏计划仍无法通过需求完整性检查。
- PlanStore 的文件格式和路径不变；损坏记录继续保留原文件并报告内存运行状态。close 禁止后续状态操作，并等待已安排的读写收尾。

## 回归入口

- `tests/session-lifecycle.test.ts`：切换与关闭竞态、绑定失败回退、逐项收尾、重复取消、异步模型选择。
- `tests/planning-state.test.ts`：数据引用隔离、迟到成功/失败、目录变更、预算与回执合并、执行回执归属和关闭后操作。
- 原有 permissions、interactions、core-planning、planning-clarification、core-execution、core-acceptance、code-data-integration、独立窗口及终端用例继续保留。

本阶段没有恢复主控或跨窗功能，也没有调整视觉。TUI 内部拆分与原生配置工具结构整理留给第五阶段。
