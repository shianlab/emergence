# Harness 能力与验证清单

基线：用户源码和 npm 的 DeepSeek Harness 0.2.2-alpha.2。下列接口位置均相对 `references/deepseek-harness-master/`。原型只加载核心插件，并非完整标准 profile。

| 能力 | 公开接口或服务 | 阶段一证据 | 后续工作 |
| --- | --- | --- | --- |
| 创建/释放 | `agents.create()`、AgentHandle.dispose | 实际 Registry/Loop 创建两个会话，释放 A 不影响 B，最终注册数为 0 | 接产品启动与异常清理 |
| 流式输出 | `agent/assistant-stream` | 真实 Harness 循环 + 受控 provider，按会话归属观察帧 | 工具卡与持久消息对齐 |
| 模型路由 | AgentOptions、`agent.model.select()` | 两种受控 route/model；下一轮切换通过 | 外部供应商与跨模型历史兼容 |
| 取消 | `agent.cancel(cause)`、`whenIdle()` | 模型流与工具两种取消均不影响 B，A 可继续使用 | 长命令/浏览器等真实工具合作退出 |
| 后续排队 | `agent.followup()`、Inbox | 忙碌时追加，确认第二个请求执行 | 产品队列呈现和中途引导 |
| 工具执行 | `defineTool`、NativeToolExecutor | 受控模型发出工具调用，真实执行工具，结果持久记入会话事件 | 标准文件/shell 工具和审批 |
| 目录隔离 | 会话 meta.cwd；working-directory 服务 | 两个中文空格目录；受控工具从 B 所属目录读 marker | 有效目录切换、真实 shell cwd 与路径补全 |
| 历史/恢复 | Session.snapshotEvents、持久化插件、agents.resume | 已验证内存事件；恢复服务源码已读，未测磁盘恢复 | 第二阶段挂载 JSONL/SQLite 并恢复 |
| 审批 | user-approval，`approval/request` waterfall | 公开接口已定位；自有请求路由的错会话/重复/晚到回归通过 | 真实审批服务到界面端到端 |
| 问卷 | user-questions.ask / askTimed | 服务源码已读，未挂载测试 | root/child 请求所有权、界面与取消 |
| Skill | skill、skill-filesystem、tool-skill | 包与加载机制已定位，未端到端执行 | 第二阶段实际发现并调用一个 Skill |
| MCP | mcp 系列适配 | 包结构已定位，未连接服务 | 第二阶段启动可控 MCP 测试服务 |
| 子代理 | subagent / agent 所有权 | Agent 的 parent 关系接口已定位，未跑委派 | 子会话事件与任务归属，第四阶段调度 |
| 设置与凭据 | profile / settings / credentials | 模型配置文档已读；未写入真实密钥 | 凭据录入、掩码、错误和配置持久化 |

源码入口：`packages/core/agent/src/index.ts`、`packages/core/agent/src/runtime-types.ts`、`packages/core/agent-loop/`、`packages/core/tools/README.md`、`packages/session/working-directory/`、`packages/interaction/user-approval/`、`packages/interaction/user-questions/`。

SDK 比较：`packages/sdk/client/README.zh.md`、`packages/sdk/protocol/README.zh.md`。取消/关闭会话缺口通过选择进程内公开接口解决，未修改或假称补齐 SDK。

本轮没有外部模型调用。模拟 provider 只决定模型输出，实际 Harness 的循环、队列、工具执行、事件记录和取消链路均运行真实实现。受控工具根据所属会话 header 选择目录，只证明该测试工具的隔离，不替代标准 filesystem/working-directory/shell 组合的验证。
