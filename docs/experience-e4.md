# E4：Agent 编排增强

日期：2026-10-30。本阶段在现有多窗口派发之上增加角色、任务契约、预算和独立验收。本机调试优先，不安装发行包、不发布 GitHub。

## 使用

重启 `emergence`，建立执行窗口并设置各自项目和模型，再使用：

```text
/mode collaborate 1 2 3
/roles
/assign-role 2 developer "实现登录校验" "无效输入被拒绝，相关测试通过"
/tasks
/task show <任务ID>
/task accept <任务ID> "逐项核对后的文件、测试和结果证据"
/task reject <任务ID> "未达到哪条标准，以及证据"
/task repair <任务ID> "需要修复的具体问题"
```

内置 planner、researcher、developer、reviewer 四种角色。只读角色是 planner、researcher、reviewer；developer 默认自动编辑，命令仍按权限确认。角色不会改变窗口原来的权限模式；执行权限同时受主控、派发快照、执行窗口和角色约束，包含原生子代理。模型由窗口选择，角色可以声明必须匹配的 modelId，冲突时派发被拒绝，要求先切换模型。

主控模型可以使用 `emergence_dispatch` 的 `contract_json`，以及 `emergence_review`、`emergence_repair` 完成有界的派发、验收、修复循环。它会获得角色列表和实际任务状态。实际模型能否正确规划和核对证据仍取决于模型能力；运行时不会把一段总结当成客观测试证明。

旧 `/assign` 和不带 contract_json 的工具调用保留原有兼容行为，不强制新增人工验收。希望使用本阶段完整流程时，使用 `/assign-role` 或带契约的派发。旧日志仍可恢复。

## 契约、预算与配置

契约示例：

```json
{
  "role": "developer",
  "scope": ["src/auth", "tests/auth"],
  "acceptance": ["拒绝空密码", "相关测试通过"],
  "deliverables": ["变更文件", "验证结果"],
  "context": "已确认的约束、来源与交接说明",
  "maxSteps": 40,
  "maxDurationMs": 600000,
  "maxRepairs": 1
}
```

scope、acceptance、deliverables、context 作为工作约束提供给模型，scope 不是额外的操作系统文件沙箱。实际访问仍由 E2 权限规则和已有文件冲突控制管理。Skills 列表作为角色指引，模型通过现有 skill 工具读取，不能绕过工具权限。

`config.json` 的 `orchestration` 支持 maxConcurrent（默认 4，范围 1–15）和 roles 数组。自定义角色字段为 id、description、prompt、mode、可选 modelId，以及 deny、rules、skills。与内置角色同名时替换其定义。rules 使用已有 allow/ask/deny 规则结构，即使角色允许某操作，也必须同时通过主控和执行窗口限制。空闲时 `/settings reload` 加载配置；已派发任务保留角色快照。

默认每个契约任务最多 40 次模型请求、10 分钟执行时间、1 次修复；可分别配置到 200 步、1 小时、3 次。原生子代理的请求也计入所属任务步数。时间预算从开始执行计时，包含等待用户确认；超时取消任务，不能撤销已经发生的副作用。最大并发统计已派发且未结算的执行窗口。没有可靠供应商计费数据时，不显示估算费用，也不声称 token 成本受到精确硬限制。

依赖交接只传递有限长度的目标、结果摘要、部分产物和错误，完整回执仍在任务记录与会话日志。不会把所有窗口历史全量复制。

## 验收与修复

带契约的任务即使报告 success，也先进入 needs_review。主控或用户必须提供非空验收说明才能通过；缺失报告、工具错误或其他已记录失败不能被强行验收为成功。这里强制的是状态与证据说明协议，不是自动验证自然语言证据真伪；主控应实际读文件、检查测试回执再验收。

等待验收期间，依赖任务继续排队。拒绝后可以创建关联修复任务，同一失败尝试只能有一个修复任务，修复链受 maxRepairs 限制。通过修复验收后，尚在排队的下游会使用修复回执继续，原始失败记录保留。已因真实失败变成 blocked 的旧任务不会被自动复活，需要重新派发。

人工接管和取消继续有效；被取消的任务不能自动修复，被接管的窗口不能接收新派发。关闭或重启不重放未完成操作。自动修复仅通过显式 repair 调用触发，不对任意有副作用的失败命令盲目重试。

## 巡检

`npm run inspect:e4` 执行类型检查、构建、真实 Harness 的 E4 集成测试，以及 Windows ConPTY 的角色列表、契约派发、真实文件产物、证据验收和原有协作终端回归。测试模型由本机 HTTP/SSE 服务提供，没有付费模型调用。

五项 E4 集成测试覆盖验收依赖、失败不可强行通过、修复上限、角色权限、人工接管、步数/时长/并发预算以及修复后依赖放行。全部常规回归共 72 项通过。证据在 `artifacts/experience-e4/inspection.json`、`terminal.json` 和 `artifacts/experience-e4-regression.log`。未宣称完成长时间负载、所有供应商或物理输入法验收。

下一阶段 E5 是完整工作流打磨：补全、历史搜索、角色与模型选择器、任务导航及综合终端回归。
