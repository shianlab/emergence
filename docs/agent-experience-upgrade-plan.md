# Emergence Agent 交互与编排升级方案

日期：2026-10-29。状态：E1 基础交互、E2 模式与权限、E3 独立身份与指令、E4 编排增强、E5 工作流打磨已实现并通过专项巡检。使用与证据见 [第一阶段记录](experience-e1.md)、[第二阶段记录](experience-e2.md) 、[第三阶段记录](experience-e3.md) 、[第四阶段记录](experience-e4.md) 和 [第五阶段记录](experience-e5.md)。E3 的显式长期偏好通过用户可编辑的规则文件保存，不包含自动记忆或独立记忆管理器。下文对标与方案保留原始设计意图，未实施的阶段不代表功能已上线。

本方案承接现有六阶段建设，作为本地调试期间的新一轮五阶段增量改进。目标是拥有独立身份、成熟终端交互和可控自主执行能力的个人 Agent。继续使用 DeepSeek Harness 运行时，支持不同模型；安装包和 GitHub 发布仍后置。

## 一、对标结论与证据边界

核对了 Claude Code 与 OpenCode 当前官方文档，以及 Emergence 本地源码和已安装 Harness 的指令加载器。Claude Code 的内部调度实现未审计；OpenCode 搜索命中的 dev 分支源码路径本轮返回 404，因此下列竞品结论是官方公开行为，不宣称已逐行审计它们的核心源码。具体实现应对着固定版本验证，不能把不同版本、V1/V2 的配置字段混用。

| 能力 | 对标观察 | Emergence 应吸收的设计 |
|---|---|---|
| 执行模式 | Claude Code 有 Manual、Accept Edits、Plan、Auto 等模式；Shift+Tab 切换，Auto 存在可用性条件 | 单窗口可切换、状态明确、工具执行层强制生效 |
| 自动执行语义 | Claude Auto 包含分类器审查；OpenCode 文档中的 --auto 自动批准原本需询问的操作，保留 deny | 把规则自动批准和智能审查区分，明确行为与边界 |
| 权限规则 | OpenCode 支持 allow/ask/deny，以及工具、资源或命令粒度规则 | 同一规则引擎管理内建工具、Shell、MCP 和扩展 |
| 确认 | Claude 确认上下文支持方向键、Enter、Esc、Space；OpenCode 提供 once/always/reject，always 是当前会话范围 | 结构化确认卡、明确授权范围、键盘完整操作 |
| Agent 角色 | OpenCode 区分 primary/subagent，内建 Build/Plan/Explore 等角色 | 角色、模型、权限、工具组成可配置 Agent 档案 |
| 多 Agent | Claude 区分单会话子代理与独立队友；团队共享任务并可直接沟通，团队功能仍标为实验性 | 独立窗口、临时子代理、协作队友分清职责与生命周期 |
| 项目指令 | Claude 使用 CLAUDE.md；OpenCode 使用 AGENTS.md，提供 /init | EMERGENCE.md、分层加载、来源展示和初始化 |

来源：

- [Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)
- [Claude Code 键盘动作与确认上下文](https://code.claude.com/docs/en/keybindings)
- [Claude Code 子代理](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code 项目指令与记忆](https://code.claude.com/docs/en/memory)
- [Claude Code Agent 循环](https://code.claude.com/docs/en/how-claude-code-works)
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [OpenCode Permissions](https://opencode.ai/docs/permissions/)
- [OpenCode Keybinds](https://opencode.ai/docs/keybinds/)
- [OpenCode Rules](https://opencode.ai/docs/rules/)

注意：OpenCode 当前 Plan 文档并不承诺任意 Shell 都只读。Emergence 的计划模式要自行定义和执行工具约束，不能靠模式名称或提示词推断安全属性。

## 二、已核实的现状

1. `controller.ts` 的 Interaction 只有 title 和 respond(text)。审批只解析小写 y/n；问题通过选项编号或字符串回答。
2. `workspace-ui.ts` 的 onSubmit 对空文本直接返回，所以空输入按 Enter 根本没有进入审批逻辑。审批也缺少可选中的按钮或选项状态。
3. `preferences.ts` 把 Tab/Shift+Tab 用于前后窗口；目前键名支持范围很窄，不能表达完整的 Ctrl+字母、Alt 或 Leader 组合。
4. `workspace-ui.ts` 中 Ctrl+C 直接调用 exit，缺少编辑、取消任务、退出的分层行为。
5. `config.ts` 当前只有 shellMode 和工具名 deny/confirm。ask-local 下 Shell 每次需确认；这不是完整的权限模式系统。
6. `collaboration.ts` 已有任务标识、去重、依赖、排队、真实轮次关联、结果回执、人工接管及重启不重放。这些继续使用。
7. `cli.ts` 已设置 Emergence 身份提示，但未配置 EMERGENCE.md。Harness 的 dsh-agent-instructions 支持 instructionFileCandidates、localInstructionFileCandidates、项目根标识及加载预算。
8. Harness 指令加载器的用户全局路径仍围绕 DSH_HOME/AGENTS.md 等约定；只增加候选文件名不足以实现 ~/.emergence/EMERGENCE.md，需适配全局入口并防止重复加载。

## 三、产品与架构决定

### 1. 三个独立维度

- 执行模式：计划、询问、自动编辑、自动执行。
- Agent 角色：通用、规划、研究、开发、审查，以及用户自定义角色。
- 协作方式：独立指挥、主 Agent 派发。

例如：窗口 A 是“审查角色 + 计划模式 + 某模型”，窗口 B 是“开发角色 + 自动执行 + 另一模型”。切模型不重置权限，切协作方式不自动放宽权限。保留现有 `/mode independent|collaborate`；新增 `/permission` 管执行模式，避免同名含义冲突。

### 2. 执行模式

| 模式 | 建议行为 |
|---|---|
| 计划 Plan | 允许结构化读取、搜索、分析和提问；阻止业务文件修改及执行型委派。计划草稿可写指定内部计划目录。任意 Shell 和未知副作用 MCP 不作为只读工具自动放行 |
| 询问 Ask | 读取与搜索正常进行；文件修改、执行命令等副作用按规则确认 |
| 自动编辑 Edit | 当前项目内的普通文件修改可自动执行；Shell、项目外操作和未授权工具仍按规则处理 |
| 自动执行 Auto | 已配置的可自动执行范围直接运行；明确 ask/deny 继续生效，无法判定的调用询问。显示具体命中的规则 |

首版 Auto 是可解释的规则引擎，不冒称已经具备 Claude 的分类器。后续智能审查作为可选增强：先评测准确率、误放行率、误拦截率、延迟和模型费用，失败回退到询问。若以后增加完全放开选项，必须作为独立显式设置，不能混入日常模式切换或由项目文档开启。

规则应匹配工具、规范化路径、命令及参数、实际 Agent 身份和授权范围。不能把一次 `git status` 的许可扩成任意 `git *`；复合命令、解释器、重定向不能用简单字符串前缀判为只读。阶段二先支持确定可识别的操作，无法可靠解析时保留确认。

规则评估先应用运行时约束和明确禁止，再应用显式询问、限定授权及模式默认值。生效权限取任务、角色和所属窗口限制的交集；子任务不能借委派获得更高权限。

### 3. 确认协议与键盘

确认是独立交互对象，不复用聊天草稿解析。分为 permission、singleChoice、multiChoice、text 四种；必须带 requestId、sessionId、agentId、paneId、可用动作及状态版本。

- 方向键选择，Enter 执行当前高亮项，Esc 取消本次确认或返回上一层。
- Space 勾选多选项；y/n、数字为可选快捷操作，不再是唯一入口。
- 权限动作：允许本次、允许本会话内匹配操作、拒绝；显示会话许可具体覆盖的范围。
- 持久许可通过权限管理入口明确保存，不把“本会话允许”自动写成永久许可。
- 进入确认后保留聊天草稿，结束后恢复原焦点；后台请求只显示待处理状态，不抢走当前输入。
- 防止回车连发批准下一条请求：请求切换重置焦点、拒绝 key repeat、消费触发提交的按键事件。
- 过期、已取消、换会话或关闭窗口的响应无效；响应只生效一次。

建议默认快捷键（实施时经过 Windows Terminal 实测）：

| 上下文 | 操作 |
|---|---|
| 聊天输入 | Enter 发送；Shift+Enter 换行；Alt+Enter 作为可配置备用 |
| 确认/菜单 | 方向键选择，Enter 确认，Esc 返回/取消，多选 Space |
| 普通会话 | Shift+Tab 切执行模式；Ctrl+P 命令面板；Ctrl+R 输入历史搜索 |
| 窗口导航 | Ctrl+W 后按方向键选相邻窗口；保留 F2/F3/F6 等现有窗口操作 |
| 中断 | Esc 先关闭最上层交互，再用于停止当前窗口任务 |
| Ctrl+C | 有文本选择时复制；否则有草稿时清空草稿；否则有运行任务时停止当前窗口；空闲时提示再次按下退出 |

Tab 根据补全/表单上下文处理，不再全局劫持。输入历史上下键仅在合适的编辑边界生效。提供新旧键位映射和迁移提示，不静默覆盖用户自定义。事件优先级统一为：当前弹层/确认 → 补全 → 编辑器 → 窗口 → 全局。终端无法区分的键提供备用绑定及诊断。

### 4. 独立身份与 EMERGENCE.md

推荐规范名 `EMERGENCE.md`，兼容用户希望的 `emergence.md`。Windows 上按同一文件去重；区分大小写的系统如果两个名字同时存在，优先规范名并给出来源提示。

拟定目录：

```text
~/.emergence/
  EMERGENCE.md            # 个人长期偏好、工作方式
  config.json             # 模型、权限与运行参数
  agents/                 # 个人 Agent 角色定义
  memory/                 # 可查看、编辑和删除的记忆

项目/
  EMERGENCE.md            # 项目目标、架构、命令、约定、验收标准
  EMERGENCE.local.md      # 本机项目偏好，不提交的本地覆盖
  .emergence/
    agents/               # 项目角色定义
    plans/                # 计划与验收清单
```

加载顺序：个人规则 → 项目根规则 → 所操作子目录规则 → 对应本地覆盖。同一作用域可兼容 AGENTS.md，Emergence 专用约定优先；CLAUDE.md 兼容做可配置入口。直接用户指令与运行时权限优先于这些文档，Markdown 不能授权 Shell、开启扩展或改写权限配置。

根目录必须有清晰边界：Git 根或显式项目根；无 Git 时使用启动项目边界，不能一路搜到磁盘根。子目录规则按实际操作范围加载，跨项目窗口相互隔离。提供 `/instructions` 查看文件、作用域、摘要、截断和冲突提示，`/instructions reload` 在下一安全边界刷新；不声称现有 Harness 自动监控所有外部编辑。

`/init` 根据项目生成文件草案；已存在时展示修改预览并按当前编辑权限执行，保留已有约定，不覆盖成通用模板。每个用户拥有自己的全局文件，项目文件可共享。

身份指令、运行配置、角色定义、自动记忆分别管理。长期记忆先采用用户明确保存和可撤销机制；不会把模型每次猜测都写成“灵魂”。已有供应商、开源许可证与归属信息如实保留，产品身份由 Emergence 定义。

### 5. 编排重点

保留 Harness 的模型/工具循环、会话事件、Skills、MCP 和持久化。Emergence 在其上负责权限、角色、任务调度、交互请求和用户可理解的状态。

- 区分可见窗口、后台临时子代理、协作队友。窗口是视图，任务是工作单元，Agent 是执行者；任务不能只靠窗口序号定位。
- 引入角色档案：用途描述、提示词、默认模型、工具范围、权限上限、Skills、并发和步数限制。用适配层兼容现有原生子代理与独立工作窗口的不同审批机制。
- 每次派发形成任务契约：目标、范围、依赖、产物、验收标准、预算和交接上下文。主 Agent 可在用户授权范围内自动拆分与指派。
- 结果带任务 ID、实际变更、验证命令与结果、未完成项；主 Agent 检查证据后汇总。worker 的 success 报告只表示提交完成，不直接等于通过验收。
- 先启用有界的“规划 → 执行 → 验证 → 必要时修复”闭环；最大并发、轮数、时长及可用 token 预算防止反复无效循环。费用只在有可信计费数据时显示。
- 上下文按任务提取，保留关键约束与来源；避免把所有窗口历史全量复制。模型能力不满足任务时明确提示或选择兼容模型。
- 同一项目写入采用任务范围、文件占用和现有 worktree 隔离；现有文件冲突防护不覆盖任意 Shell/MCP 外部修改，不能宣称完整沙箱。
- 人工可随时接管、发补充指令、取消和重新分派。失败重试分清只读请求与已有副作用操作，保留“重启不自动重放命令”的既有保障。

## 四、五阶段实施与验收

| 阶段 | 交付 | 验收门槛 |
|---|---|---|
| E1 基础交互修复 | 结构化确认协议、确认选择器、Enter/Esc/方向键、焦点与草稿保护、Ctrl+C 分层；命令/按键动作注册骨架 | 无需输入 y/n 即可完成审批；连续两次审批不串单；后台审批不抢输入；取消一个窗口不退出全部窗口 |
| E2 模式与权限 | 每窗口 Plan/Ask/Edit/Auto、统一决策引擎、会话内许可、模式菜单与快捷键、持久配置迁移 | 同时运行不同模式；计划模式无法通过子代理或工具绕过；切模式不清空历史；重复授权只在限定范围生效 |
| E3 独立身份与指令 | EMERGENCE.md 全局/项目/子目录加载、/init、/instructions、显式记忆与兼容规则 | 新项目首次启动即读规则；两个项目不串规则；恢复会话能识别规则变化；不会重复注入或静默吞掉超限内容 |
| E4 Agent 编排增强 | 角色档案、任务契约、权限继承、上下文交接、预算、结果验收与有限修复闭环、接管 | 主 Agent 把研究/实现/验证派到不同模型；依赖与失败可追踪；假完成进入待验收/失败；人工接管后不会继续自动抢任务 |
| E5 完整工作流打磨 | 补齐命令补全、历史搜索、角色/模型选择器、任务导航；Windows 终端兼容与综合回归 | 能连续完成“计划→改动→运行→确认→验证→多窗口协作→关闭恢复”，按键和焦点一致，密钥不进入导出，已有功能无回归 |

E1 优先解决用户已遇到的阻塞；E2 紧接提供模式切换。每阶段提交实际可运行成果、巡检结果和明确的未完成项，不等五阶段全部做完才试用。不承诺只凭快捷键和一个 Markdown 文件就达到竞品全部能力。

测试分层：决策引擎单元测试、真实 Harness 会话集成测试、原生 TUI/ConPTY 按键测试、Windows Terminal 人工试用。物理中文输入法组合态与不同终端按键编码需要实测，不能用 ASCII 自动测试替代。真实模型烟测少量按需执行。

## 五、与另一个 UI 页面的协作契约

本页负责权限、Agent 角色、任务/会话状态、交互协议和验收。另一个页面负责黑白灰视觉、Logo、首页/对话页布局及组件展示。采用仓库 AGENTS.md 的视觉约定；本方案未启动其四阶段生产 UI 改造。

先约定以下数据契约，具体类型放独立模块，UI 不自己判断能否执行工具：

```ts
type PermissionMode = 'plan' | 'ask' | 'edit' | 'auto';
type InteractionKind = 'permission' | 'singleChoice' | 'multiChoice' | 'text';
// InteractionRequest: id, version, paneId, sessionId, agentId,
// kind, title, detail, options, allowedActions, status。
// respondInteraction(id, version, action/value): 原子响应、校验归属、过期拒绝。
// setPermissionMode(paneId, mode): 更新权限版本，发布变更事件。
// CommandDescriptor: id, title, category, shortcut, available(context), execute。
```

模式变更不得默认批准已经挂起的调用；收紧权限后执行前重验，已发出副作用不能假装撤回。可选择等待正在执行的工具结束或显式取消，再完成只读切换，并在状态中显示过渡。

旧 Interaction.respond(text) 保留短期适配用于现有 CLI/测试，逐步迁移；协议中必须表达选项、取消、过期，不能让 UI 从中文 title 中解析业务含义。

优先新增独立模块；涉及 controller.ts、workspace.ts、workspace-ui.ts、preferences.ts 的交接需核对当前文件，避免两边覆盖。对本轮 E1/E2 的按键与确认行为修改单独接入，不擅自重做另一个页面尚待确认的整体视觉。

## 六、开始顺序

E1–E3 已完成结构化确认、命令入口、每窗口执行模式、权限规则与继承、EMERGENCE.md 分层加载与初始化，并通过真实终端验证。E4 已增加角色档案、契约派发、上下文交接、预算与验收修复闭环，旧无契约派发保持兼容。E5 已补齐历史搜索、模型/角色/任务选择器和命令补全，并完成跨终端工作流回归。E1–E5 完成，进入本机试用与问题修复。
