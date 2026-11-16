# 涌现 · Emergence：TUI 架构与交互调研

调研日期：2026-10-29（Asia/Shanghai）  
范围：用户提供的两个源码压缩包，以及 8 个外部项目。  
证据：官方文档、仓库目录、关键源码；外部源码版本记录在 `sources.json`。本轮未安装运行这些应用，未做性能测试或 Windows 实机交互测试。界面分析来自布局、输入与会话组件及官方交互说明，不等同于实际体验评测。

## 1. 已确认的产品需求

- 安装后输入 `emergence` 启动；默认工作目录为当前目录，也支持指定项目路径。
- 单终端内多个窗格，每个窗格可选择项目、会话和模型。
- 支持同项目/不同项目、同模型/不同模型的任意组合。
- 独立模式由用户分别指挥；协作模式由主控派发任务，用户仍能介入。
- 复用 DeepSeek Harness 的执行与扩展能力，具备自己的界面、品牌、配置和扩展入口。
- 六阶段交付顺序保持；本轮调研属于第一阶段的前置工作。

## 2. 项目对照与借鉴方向

### DeepSeek Harness：执行底座

本地 `deepseek-harness-master.zip` 的根包版本为 `0.2.2-alpha.2`。已读 SDK client/server/protocol、llm-pi-ai 文档和仓库架构说明。

其模型层已有 pi-ai 多供应商适配，支持配置自定义网关；因此涌现应先验证并复用这条接入能力。界面选择模型、运行时应用配置、供应商实际支持哪些参数，必须分别处理。

一个重要限制：此版本 SDK 文档明确没有轮次中取消、没有会话关闭 RPC；终止执行需要关闭运行时进程。SDK 恢复会话也不会恢复 shell、浏览器等外部进程。不能把“SDK 能驱动任务”推导成“足够支撑所有交互操作”。

需要补齐能力对照：流式输出、历史回放、取消、排队、模型切换、目录切换、审批、问卷、Skill/MCP 管理、子代理归属、错误与退出。每项都要指向真实接口和验证用例。

证据位置（压缩包内）：`packages/sdk/client/README.zh.md`、`packages/sdk/protocol/README.zh.md`、`packages/sdk/server/README.zh.md`、`packages/llm/llm-pi-ai/README.zh.md`。

### dsh-TUI：最直接的适配参考

本地 `dsh-TUI-main.zip` 版本 `0.17.0`，主验证上游为 `0.2.1-rc.3`，与另一压缩包不是同一个版本基线。

它通过后端中立的 AgentSession/AgentEvent，把执行事件投影成界面状态；DSH 适配集中在自己的目录，UI 不需要直接理解每种后端。React 配合仓内 Ink 系渲染器，已有输入、流式输出、工具卡、侧栏、主题和终端适配。

其会话挂载设计允许切走后继续执行，但已有左右布局主要是聊天与辅助面板。多会话同时运行、会话切换、多个完整聊天窗格同时显示，是三个不同层面的能力。不能直接把 Chat 组件复制多份就认为完成多窗格：全局按键、弹层、输入、审批路由都需要重新界定作用范围。

优先借鉴后端适配、事件投影、会话生命周期；渲染器复用需评估维护成本。它有自己的 Ink/Yoga 相关实现，不能视为单纯安装一个通用 Ink 依赖。

证据位置：`ADAPTER.md`、`docs/architecture.md`、`docs/session-mount-runtime.md`、`src/agent/session.ts`、`src/components/sidePanel/SidePanelLayout.tsx`。

### OpenCode：界面与执行服务分层

本次读取的 dev 源码已经把 TUI 放在 `packages/tui`，其中包版本为 `2.2.0`；网上旧教程的目录和实现可能不适用。当前源码使用 Solid/OpenTUI，存在独立客户端、会话标签状态和拖拽调宽组件。

`context/client.tsx` 把连接与事件订阅集中处理；`session-tabs.tsx` 与 `session-tabs-model.ts` 管理标签、关闭重开及状态；`pane-resize.ts` 把尺寸限制、拖拽过程和提交偏好分开。

涌现可以借鉴这三个边界：连接、会话导航、布局。标签系统能参考，但本轮证据不足以认定它已经提供涌现所需的任意多聊天分屏。

来源：[TUI 源码目录](https://github.com/anomalyco/opencode/tree/c1b5f1b416c2bff799a4be6a75d640e9ba28d42f/packages/tui/src)、[服务接口文档](https://opencode.ai/docs/server/)。

### OpenTUI：独立渲染器候选

OpenTUI 提供 Zig 原生实现及 TypeScript 接口，支持 React 和 Solid。布局、滚动、鼠标和输入组件适合进入多窗格原型比较。

本次固定源码的 core 文档声明：Bun 1.3.14+；或 Node 26.4.0+、ESM 与 `--experimental-ffi`。Windows arm64 的 Bun 要求更高。这是该源码版本的要求，不代表所有历史版本或当前 npm 发布版。开发原生部分还涉及 Zig，应用消费预编译包与从源码构建应分别评估。

采用它会增加原生包和运行时分发的验证工作。先验证 Windows x64、中文路径、中文输入、退出清理和依赖安装，再决定是否使用；不能仅凭项目流行程度确定选型。

来源：[core 文档](https://github.com/anomalyco/opentui/blob/1e041e9676400fe1dab84c61d4da43ec1485864e/packages/core/README.md)、[项目说明](https://github.com/anomalyco/opentui)。

### Pi：会话 API 与扩展生命周期

原 `badlogic/pi-mono` 地址现重定向到 `earendil-works/pi`。当前文档的包名与用户 Harness 所依赖的历史 pi-ai 命名可能不同，不应直接替换依赖。

SDK 把模型、工具、消息队列和扩展归入会话；明确区分中途引导和后续排队，并要求切换会话实例后重新绑定订阅。扩展提供工具、命令、自定义 UI 等入口。

pi-tui 目前同时有主屏与备用屏渲染，具备布局、滚动、焦点和浮层接口，不能沿用“它只能做单列输出”的旧印象。

涌现应借鉴会话资源归属和扩展生命周期。Pi 的默认产品取舍与我们的多窗格主控协作目标不同，不应为其简洁而替换已选 Harness。

来源：[SDK](https://github.com/earendil-works/pi/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/packages/coding-agent/docs/sdk.md)、[扩展](https://github.com/earendil-works/pi/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/packages/coding-agent/docs/extensions.md)、[TUI](https://github.com/earendil-works/pi/blob/e65b3b88c08412bb8ffbd21fb5dc5756064a6e5a/packages/tui/README.md)。

### Crush：布局、焦点与交互状态

其 Go 界面使用 Bubble Tea，配合 Ultraviolet 屏幕缓冲与矩形区域绘制。顶层处理消息、焦点和布局，子组件通过明确方法接受操作；文档要求耗时 I/O 离开 UI 更新路径。

值得借鉴的是输入、消息区、侧栏、弹层之间的焦点规则，以及按区域组织渲染。涌现应统一分发输入，但将每个窗格状态隔离，避免让所有会话挤进一个巨大的 UI 状态对象。

Go 路线可以作为参考；为了连接 TypeScript Harness，直接采用它会增加跨语言通信和分发工作，本轮没有足够收益证据支持切换语言。

来源：[UI 架构](https://github.com/charmbracelet/crush/blob/main/internal/ui/AGENTS.md)、[UI 实现](https://github.com/charmbracelet/crush/blob/a945ccf9c17a59d98a9e07107011a88ded0ac513/internal/ui/model/ui.go)。

### Codex CLI：终端恢复与结构化后端通信

抽查的 TUI 依赖和源码使用 Ratatui/Crossterm，并有 Windows 控制台、按键序列和终端恢复处理。App Server 提供可供不同界面消费的结构化通信边界。

对涌现最有用的是：工具结果、审批、任务状态和错误应通过结构化事件传递；终端原始模式、粘贴模式和光标等必须在退出时恢复。不要通过读取屏幕文字判断工具是否成功。

这不意味着第一版要改用 Rust。未来接 Codex 后端时，应优先评估其公开协议，单独建立能力映射。

来源：[终端实现](https://github.com/openai/codex/blob/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs/tui/src/tui.rs)、[依赖](https://github.com/openai/codex/blob/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs/tui/Cargo.toml)、[官方 App Server 设计](https://openai.com/index/unlocking-the-codex-harness/)。

### Agent Deck：最贴近主控派活的产品参考

它管理多个 Agent CLI 会话，提供分组、状态、worktree 和 conductor。conductor 本身也是一个持久 Agent 会话，有自己的状态、指令和任务记录，并接收子会话状态通知。

它的实现依赖 Bubble Tea 与 tmux，官方 README 列出的平台为 macOS、Linux、WSL。适合学习任务组织和父子关系，但不能据此承诺原生 PowerShell 下直接复用。

涌现可以采用主控与执行者角色、父子任务链接、忙碌时队列、状态变化通知。第一版不需要远程聊天渠道和 watcher 服务。主控派活应走明确调度接口，并保留用户接管与取消权。

来源：[项目说明](https://github.com/asheshgoplani/agent-deck)、[Conductor 设计与生命周期](https://github.com/asheshgoplani/agent-deck/blob/967e2faf2b98b30da61206baaeff6bf998709f1b/docs/conductor/README.md)。

### Zellij 与 Lazygit：补足布局和键盘设计

Zellij 的布局文件表达窗格和标签，支持嵌套分割；源码区分平铺窗格、浮动窗格、PaneId 与 PTY。涌现适合借鉴布局树和稳定窗格身份，暂不需要实现完整终端模拟器。其平台支持本轮未完成实机验证，也不依据旧资料推断当前是否支持原生 Windows。

Lazygit 将界面上下文、按键控制器、展示和系统命令分开。可借鉴焦点区域对应的快捷键提示，以及可配置命令；不需要将整套 Git 操作界面搬入第一版。

来源：[Zellij 布局](https://zellij.dev/documentation/layouts.html)、[Tab 源码](https://github.com/zellij-org/zellij/blob/1f3df933978e00c246553070310175c392fcfe4f/zellij-server/src/tab/mod.rs)、[Lazygit 代码结构](https://github.com/jesseduffield/lazygit/blob/4e1eebe278790f257a875da6633234391a5a85b3/docs/dev/Codebase_Guide.md)。

## 3. 对涌现架构的建议

以下是根据上述证据作出的设计建议，尚未通过原型验证。

```text
emergence 命令入口
  └─ 工作台：布局、焦点、项目与模型选择、通知
       ├─ 窗格视图：输入草稿、滚动位置、选区
       ├─ 会话注册表：历史、运行状态、能力、事件订阅
       ├─ 协作调度：角色、派发、队列、结果、人工接管
       └─ 后端适配
            └─ DeepSeek Harness
                 ├─ 模型供应商与凭据
                 └─ 工具、Skill、MCP、子代理、持久化
```

### 分开管理四种身份

- workspace：项目目录及可选 worktree。
- session：持续存在的对话及运行上下文。
- pane：显示某个会话的区域及其局部交互状态。
- task：一次被派发的工作，关联发起方、执行会话、状态与结果。

窗格位置不是会话身份；模型不是 Agent 后端；工具调用成功也不是整个任务完成。任务与会话的关联需使用稳定 ID。事件至少携带会话/任务归属及可排序序号，审批需要独立 request ID，防止切换窗口后答错请求。

### 两个独立的选型问题

| 选择 | 优势 | 必须验证的代价 |
| --- | --- | --- |
| Harness 进程内插件/公开服务 | 最接近 dsh-TUI 的完整交互能力 | 版本耦合、生命周期与插件组合；故障隔离较弱 |
| Harness 现有 SDK 子进程 | 明确通信边界，进程隔离 | 当前取消/关闭会话接口缺口、历史回放、热切换覆盖度 |
| dsh-TUI React/Ink 系路线 | Harness 适配与终端组件参考最直接 | 自维护渲染器成本、多个聊天窗格的全局交互拆分 |
| OpenTUI + React 或 Solid | 专用布局、输入、滚动与鼠标能力 | 原生依赖、运行时要求、Windows 和中文实测 |

倾向保持 TypeScript，优先比较后两种渲染方案。Harness 接入方式与渲染器选择分开决策。不要提前规定“一窗格一进程”：隐藏/移动窗格不应改变会话运行归属。若未来采用会话级进程隔离，也应由会话管理层持有进程。

首版默认随应用退出停止运行，并明确提示未完成任务。关闭界面后继续执行需要独立后台运行时，是额外产品能力，当前不隐含承诺。恢复记录、恢复模型执行、恢复外部进程应分别描述。

## 4. 界面与交互方向

建议默认全屏，顶部显示工作区/模式，中央是可分割的会话区，底部显示与当前焦点匹配的快捷键。任务列表按需展开，避免固定占据大量宽度。

```text
涌现 · Emergence     工作空间：开发      模式：协作
┌ 主控 · 项目 A · 模型 X ─┬ 执行者 1 · 项目 A · 模型 Y ┐
│ 目标与分工              │ 流式输出、工具执行           │
│ 子任务进度              │ 状态：运行中                 │
│ > 输入                  │ > 输入/后续队列              │
├────────────────────────┼─────────────────────────────┤
│ 执行者 2 · 项目 B        │ 任务列表 / 另一个会话         │
│ 状态：等待用户确认       │                             │
└────────────────────────┴─────────────────────────────┘
焦点：主控       运行 2 · 待确认 1       分屏 / 切换 / 最大化
```

这是讨论用结构草图，不是已实现的界面。

- 全局快捷键只处理工作台操作；编辑器、滚动和发送只作用于焦点窗格。
- 后台会话需要确认时先出现带归属的提示，不随意抢走正在输入的焦点。
- 临时最大化和窄屏折叠保留原布局、草稿和滚动位置。
- 初期验证 2 窗格与 4 窗格；布局结构支持递归分割，但不承诺任意数量都可流畅显示。
- 共享目录时，每个会话仍有独立上下文。文件修改冲突需可见；worktree 可选，不把它强制套到非 Git 项目。
- 模型修改默认从下一轮生效；跨供应商继续已有会话需验证工具消息格式与上下文兼容，不应暗中截断历史。

## 5. 在第一阶段加入两个小型验证

调研结束后，先验证高风险接口，再正式锁定架构。本轮没有开始实现这些原型。

### A. Harness 能力验证

同一版本组合下，建立两个不同目录/模型的会话；验证流式输出、工具执行、Skill、审批、问卷、排队、恢复。关键关口是停止 A 时 B 不受影响，以及切换会话不会误路由事件或确认。再验证模型切换与持久化历史的处理。

若 SDK 无法满足取消与会话控制，应选择进程内公开服务，或评估受控桥接插件；桥接的接口和维护责任必须写明，不能称为现有 SDK 已支持。

### B. 终端与渲染验证

用相同的模拟流式事件比较两个渲染候选，避免把模型网络速度误当 UI 性能。分别验证 2/4 窗格、长历史、独立滚动、多行粘贴、中文/emoji 宽度、拖拽、弹层、缩放和异常退出。

优先环境为 Windows Terminal + PowerShell，并补充 VS Code 集成终端；使用包含中文和空格的路径。记录实际终端/字体/运行时版本、CPU/内存、输入响应和退出后的终端状态。macOS/Linux 可在后续环境可用时补测，不以 Windows 测试代替。

## 6. 六阶段计划的调整

| 阶段 | 调研后的重点 |
| --- | --- |
| 1. 架构与界面 | 完成本调研；增加 Harness/渲染两类小验证；据结果固定版本与选型 |
| 2. 单窗格 | 立即验证取消、审批、历史和扩展加载；不只验证聊天 |
| 3. 多窗格 | 窗格与会话分离；输入和确认准确路由；可见窗格渲染预算 |
| 4. 主控协作 | 主控/执行者关系、明确队列与结果；避免重复派发；人工接管和失败处理 |
| 5. 个性化 | 用能力声明控制可用设置，完善 Skill/MCP、主题和工作区模板 |
| 6. 发布稳定性 | 扩大平台覆盖与性能验证；终端基础适配从阶段 1 持续做，不延后到此阶段 |

当前可以确认产品方向与模块职责；渲染器和 Harness 连接方案仍应由上述小验证决定。没有证据支持现在就承诺“所有 Harness 功能、所有模型和所有终端完全兼容”。
