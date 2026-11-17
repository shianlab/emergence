# 涌现 · Emergence

源码安装入口见[根目录快速开始](../README.md)。当前有效验收入口为 `npm run inspect:full`、`npm run check` 与 `npm run inspect:security`；带阶段编号的报告只记录当时实现，失效的历史命令已退出。

当前版本为 **1.01（程序版本 1.0.1）**，使用 OpenTUI 与 DeepSeek Harness 的真实 profile、工具和会话服务。首次安装、升级与卸载见[安装指南](../docs/installation.md)，源码开发见[根目录 README](../README.md)。本文保留详细配置与使用说明；阶段报告中的旧产品范围以当前独立窗口行为为准。

应用运行层为 **Emergence Harness**，整合 DeepSeek 开源执行底座、原生 TUI、多窗口独立会话、权限与 Meta_Kim 治理方法。2026-11-16 起取消主控及跨窗口协同：各窗口分别接收任务，可使用不同项目和模型；不自动派活、不相互控制。单会话 KIM、编程、数据分析、记忆、Skills/MCP 和原生子代理保持可用。

核心整合第六阶段的完整链路、实网模型检查、故障与性能记录见[整体验收与试用报告](../docs/core-integration-phase6-report.md)。`npm run inspect:full` 可复现不调用付费 API 的完整矩阵；五分钟稳定性单独运行 `npm run test:stability`；`npm run test:core-live` 单独检查已配置模型，会产生少量 API 用量。

原生编程增强已接入项目理解、受控修改、真实检查回执、恢复预览和文件版本核对。直接用自然语言布置编程任务即可，使用范围与实测结果见[编程闭环第三阶段报告](../docs/code-data-phase3-report.md)；本机数据画像与只读 SQL 已接入，见[第四阶段范围及验证](../docs/code-data-phase4-report.md)。专用远程数据源仍待接入。

模板、主题、快捷键、Skill/MCP 和扩展的使用见[个性化指南](../docs/phase5/personalization.md)，既有问题修复记录见[第五阶段整体复查](../docs/fixes/phase5-audit-2026-10-29.md)。

确认选择器、Enter/Esc、Ctrl+P 独立命令入口及 Ctrl+C 分层行为已更新，见 [E1 交互说明与巡检](../docs/experience-e1.md)。专项检查运行 `npm run inspect:full`。

## 启动

```powershell
cd M:\你的项目
emergence
```

首次使用可在首页输入 `/model-config`，在原生配置窗口添加模型与密钥；已有加密凭据无需重复输入。也可运行 `emergence auth --key-file <文件路径>`，使用 Windows DPAPI 绑定当前用户保存。显式环境变量仍优先，可临时覆盖加密凭据。

当前模型以首页和 `/model` 中的实际配置为准，各窗口可分别选择。环境变量对当前终端及其子进程生效；密钥不要作为聊天消息发送给模型。

```powershell
emergence M:\另一个项目
emergence --version
emergence models
emergence config
emergence model-config
emergence --fresh
```

首次运行创建 `%USERPROFILE%\.emergence\config.json`。配置只记录密钥环境变量名，不记录密钥值；Windows 加密凭据位于同目录 `credentials.dpapi.json`，仅用于向运行时注入环境变量。`EMERGENCE_HOME` 或 `--home` 可指定独立配置/会话目录。

普通运行 `emergence` 先进入黑白灰首页，展示手写像素 Logo、实际模型和项目目录。首页空闲时不创建 Agent、不调用模型，也不写入工作台布局。输入第一条任务后进入新对话；新建前会把已有布局完整备份为 `workspaces/*.before-home-*.json`，会话历史保留。

首次使用按“配置模型 → 确认项目目录 → 输入任务”推进。进入对话后，`/project "目录"` 可切换当前窗口项目。`/help` 提供中文步骤；输入 `/` 后用 ↑↓ 选择、Tab 补全、Enter 确认。

本轮首发验收目标为 Windows 11 x64。源码调试继续使用项目固定的 Node；可搬运候选目录自带相同 Node 和生产依赖，不要求全局 Node。两种方式共用一个 CLI 和数据初始化流程，npm 公共发布仍未开启。安装/升级与用户数据保留规则见 [运行与升级说明](../docs/iteration-20261108/runtime-and-upgrade.md)。

首页和对话页均可使用 `/doctor`，终端也可运行 `emergence doctor "项目目录"`。诊断只读检查 Node、配置、凭据是否存在、Git 与数据 Python 环境，不发送模型请求，也不验证 API 连通性。没有 Git 仓库仍可使用普通任务；缺少数据 Python 仅影响内置数据计算。不要为消除提示而把整个用户目录初始化成仓库。

编程任务中，`/code` 展示当前窗口项目的真实检查回执、执行目录、退出码、诊断和本轮变更；未运行、失败或版本过期不会显示为通过。`/code preview "文件路径"` 只预览恢复，实际恢复仍须核对文件版本并经过工具权限。子项目检查按实际执行目录归属，不能代替根项目检查。

首页输入 `/continue`，或点击「继续工作台」，恢复当前目录上次保存的布局、草稿和历史；`/sessions` 可选择历史会话，`/model` 可为下一会话选择模型。显式 `--resume <id>` 或 `--template <名称>` 直接进入对应工作台。`--model <配置>` 在继续布局时只覆盖焦点窗口的模型。`--fresh` 仍保留历史，从首页开始新建。

首页采用靠上的居中标识：缩小的手写像素「涌现」下方是像素英文 `EMERGENCE`，运行信息统一排在标识下方，输入区同轴居中。中文使用更细的象限块保留原稿轮廓，120/160 列使用 56 列标识，80×24 终端使用 40 列标识；较窄或较矮终端保留文字品牌与输入区。输入、模型状态、快捷键与入口之间分组留白。`NO_COLOR`、`TERM=dumb` 或 `EMERGENCE_REDUCED_MOTION=1` 可关闭首页显现动画。`--print`、`--help`、`--version` 保持自动化输出，不显示首页。

## 多窗口工作

工作台左上角使用用户选定的 A 版火山兽，8 列 × 3 行（可见高度约两排半），暖橙熔岩、炭黑岩体、米白眼睛；右侧为小号 Emergence、模式和会话统计。原生半块字符不依赖终端图片协议。固定轮廓内的亮度和眨眼轻微变化，不向外喷散火星，随当前会话的思考、工具/确认、完成和错误状态反馈；减少动态效果时静止，NO_COLOR 下用灰阶，低于 46 列或 24 行时保留文字品牌。首页继续使用定稿书法标识。顶部会话导航可点击切换或显示后台窗口，标明会话、后台/折叠状态；后台待确认以 `◇` 提醒。单会话采用开放阅读区，多窗格使用灰阶边界和字重区分焦点，长目录保留末尾路径。

点击右上角「任务」，或通过 `/tasks`、F4 选择任务后按 Enter，打开结构化详情；`/task show <ID>` 可直接查看。宽度达到 118 列时详情放在右侧，更窄时进入任务页。↑↓ 选择任务，PageUp/PageDown 滚动详情，Enter 或「进入执行窗口」跳转到该任务绑定的原会话，Esc 返回对话。查看任务保留草稿、选区和阅读位置，关闭面板不会停止任务；任务结果、失败回执和验收证据分开展示。详见[第四阶段记录](../docs/design/tui-phase4-report.md)。

输入区默认 3 行，随原生编辑器的实际折行增长，常规窗口最多 7 行；空间较小时缩小上限，超出后在编辑区内滚动。中文、emoji、多行内容和任务文本首尾空白保留。运行中 Enter 将新输入加入会话队列，输入区上方显示实际工具、排队条数和停止/等待回答状态；底部操作提示随当前状态变化，停止键遵循 `/keys` 的实际配置。

输入 `/` 显示命令候选，用 ↑↓ 选择、Enter 确认、Esc 关闭；需要参数的命令先补全，再填写参数。Ctrl+P 可按命令名或中文说明筛选，也可直接输入完整命令；取消后聊天草稿和选区继续保留。发送失败时恢复原草稿、光标与选区，已有新草稿时不覆盖。详见[第三阶段记录](../docs/design/tui-phase3-report.md)。

对话页已经接入结构化消息：助手回复中的标题、加粗、列表、引用、代码和表格按终端样式排版；用户内容、工具参数和输出保持原文。工具默认显示摘要，点击「展开」查看详情，失败详情默认展开。项目指引和运行上下文单独折叠，不混入助手正文。

对话角色使用不同灰阶：用户消息采用更明显的深灰底、浅灰文字和左侧灰线；涌现回复采用近黑背景、灰白正文及更亮的发言人标题。浅色主题对应调整明暗，原文、复制和 Markdown 排版保持原有行为。

点击助手消息的「原文 / 排版」切换视图，或使用 `/view raw [消息序号]`、`/view render [消息序号]`；省略序号时作用于最近一条助手消息。`/view tools [序号]` 展开或收起工具；`/view more [序号]` 加载更长内容；`/view latest` 回到最新。也可按 Ctrl+P 输入这些命令。向上阅读时，新输出不会拉回底部，并显示「有新内容」提示。完整历史与 Markdown 原文仍保留在会话日志，`/context export <文件>` 可导出快照。验收与边界见[第二阶段记录](../docs/design/tui-phase2-report.md)。

运行上下文、项目指引、技能目录默认收进「背景资料」入口，点击或输入 `/view context` 查看；这只影响显示，不删除规则，也不禁用 Skills。任务的成功分析会显示「需求理解」：目标、约束、验收、待确认项与处理方式。仅讨论或待澄清时，核心阻止实施；收到后续输入后重新分析。普通问答不强制增加分析卡。实现和验证范围见[需求理解与后台资料](../docs/intent-and-background-context.md)。

F2/F3 使用当前窗口的项目与模型创建独立会话。也可以直接指定其他项目和模型配置：

```text
/split right "M:\另一个项目" deepseek
/split down "M:\当前项目" gateway
/model gateway
/project "M:\新项目"
```

每个窗口有自己的会话、项目、模型、输入草稿、滚动位置和运行状态。Tab 或鼠标点击切换，后台审批/问卷只在所属窗口等待，通知不会抢焦点。窄屏自动只显示焦点窗口，扩大终端后恢复原布局；当前最多托管 16 个会话，主要验收 2/4 窗口。

**关闭窗口：按 F6、点击标题栏的 `[关闭]`，或输入 `/close`。** 也可 `/close <编号或ID>` 关闭其他可见或后台窗口，原 `/terminate` 命令继续可用。关闭会停止相关任务、释放会话并从布局移除，历史仍保留；重启不会重新打开已关闭窗口。只剩一个可见窗口时，会自动显示其他隐藏窗口接替；整个工作台至少保留一个窗口，退出请在空闲时连按两次 Ctrl+C，或从 Ctrl+P 输入 `/exit`。

F8 或 `/hide` 隐藏当前窗口，任务继续执行。`/panes` 查看可见和后台会话，再用 `/show <编号或ID>` 显示、`/focus <编号或ID>` 切换。退出整个应用会停止所有会话，重新启动恢复记录与布局，不自动重新执行此前任务。

同目录窗口会显示共享项目提示。工作台会拒绝自身 `write/edit` 工具对同一文件的重叠修改，并提示其他会话修改前重新读取；这不能覆盖 shell、MCP、外部编辑器或先后发生的过期内容覆盖。需要隔离时，从 Git 项目运行 `/worktree "M:\新的工作树目录"`，创建 detached HEAD 工作树并打开窗口；终止窗口后工作树保留，成果整合由用户处理。

## 独立窗口与历史兼容

每个窗口由用户分别布置任务。右键菜单提供分屏、切换模型、最大化和关闭；没有主窗口、红色主控边框、角色分配、自动派活或跨窗审查。旧的 /mode、/assign、/assign-role、/team、/window-role、/dispatch、/takeover 和 /release 会提示功能已移除。

旧工作台继续恢复布局、模型、会话和草稿；旧角色关系不再启用，未结束的跨窗口任务不重放，任务与证据记录仍保留。旧模板只恢复项目、模型和布局。需要继续历史任务时，在对应窗口提交一条独立任务即可。

### Git 工作树成果整合

先提交执行工作树中的成果，再在目标窗口输入 `/integrate <源窗口编号>`。只允许同一仓库的两个不同工作树，源和目标都必须空闲、干净且没有待处理合并。该命令合并指定源 HEAD，不自动运行测试；源窗口最近任务尚未通过时，整合结果仍标为“待检查”。

`/integrations` 查看提交、整合结果和冲突文件。冲突保留在目标工作树，用户解决并提交，或显式运行 `git merge --abort`。不会自动 stash、重置文件或跨项目合并；重启前未确认的整合保持待检查。

## 可视化模型配置

直接双击项目根目录或发行目录的 `涌现模型配置.exe`。按钮、输入框、下拉框及页签全部是 Windows Forms 原生控件，白底小窗，无网页或浏览器依赖；独立关闭时清理隐藏后端。

运行 `emergence model-config`，或在首页点击“模型配置”。对话中输入 `/model-config`、自然语言“怎么配置模型？”可打开同一个工具，添加和测试模型、分别配置当前独立窗口、保存新窗口默认模型。详细行为见[使用指南](../docs/model-configuration.md)。要即时切换已有窗口，请从目标工作台打开；独立命令模式管理共享配置。

## 其他模型

```powershell
emergence config add --id gateway --provider custom --model your-model-id --api openai-completions --base-url https://your-endpoint.example/v1 --key-env YOUR_MODEL_API_KEY
emergence --model gateway
```

协议配置支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。已验证 OpenAI Chat Completions 与 Anthropic Messages 的本地 HTTP/SSE 协议，并通过 DeepSeek 官方 `deepseek-flash` 的真实回复、文件工具及会话恢复。其他真实供应商仍待逐项验证。`provider` 是显示名称，`id` 是 `/model` 选择名称。

## 操作

| 操作 | 行为 |
| --- | --- |
| Enter | 发送；忙碌时排队；确认界面提交当前高亮选项 |
| ↑ / ↓、Space | 确认界面选择选项；Space 勾选多选项 |
| Ctrl+P | 独立命令入口；确认期间也可 `/focus`，输入 `/exit` 退出且保留聊天草稿 |
| Shift+Enter | 换行；多行粘贴保留为草稿，不自动发送 |
| Tab / Shift+Tab | 切换可见窗口；草稿与编辑选区保留 |
| F2 / F3 | 当前窗口左右/上下分屏 |
| F4 | 打开任务记录列表 |
| F6 / 标题栏 `[关闭]` / `/close [编号或ID]` | 关闭窗口并停止相关任务，保留历史 |
| Ctrl+A | 选中当前输入，可直接替换失败后保留的指令 |
| F7 / F8 | 最大化/还原；隐藏窗口并保持执行 |
| Ctrl+方向键、拖动分隔线 | 调整当前分屏尺寸 |
| Esc | 先关闭当前命令/列表或取消本次确认，否则停止焦点窗口任务 |
| Ctrl+C | 有选区时复制；否则清空草稿、停止当前任务；空闲时 2 秒内再按一次退出 |
| `/exit` | 保存可保存的状态并退出；需要保留当前草稿时从 Ctrl+P 命令入口执行 |
| PgUp / PgDn、滚轮 | 滚动输出或完整确认内容 |
| `/new` | 创建新会话，保留此前磁盘历史 |
| `/sessions` | 查看会话 ID 与目录 |
| `/resume <id>` | 在当前窗口恢复已有会话；已被其他窗口绑定时拒绝 |
| `/model`、`/model <id>` | 查看或从下一轮切换模型 |
| `/tools` | 查看可用工具 |

工具参数、结果和失败来自 Harness 事件。内部上下文注入显示来源摘要。当前界面显示最近 200 条可显示事件，每条最多 16000 字符；完整事件保存在会话日志，完整长历史浏览后续完善。

布局快照位于 `%USERPROFILE%\.emergence\workspaces`，按启动目录区分，保存布局、窗口会话关联、模型、草稿和滚动位置。编辑选区在本次运行中的切换、隐藏和还原时保留，重启后不恢复选区。恢复失败的窗口保留原因，可 `/retry`，或 `/project "有效目录"` 新建；损坏布局需显式 `--fresh`，不会静默覆盖。

## 命令执行与权限

本机 M 盘无法完成 Harness Windows AppContainer 的写权限授予。默认 `shellMode: "ask-local"` 使用直接在本机执行的 PowerShell，每次命令先由界面确认：`y` 允许本次，`n` 拒绝，Esc 取消。文件工具保留 Harness 的文件策略。

配置 `shellMode: "sandbox"` 可使用上游 shell 沙箱，是否可用取决于盘符和系统权限，失败明确显示。

自动化执行可用 `emergence M:\项目 --print '检查项目结构'`，输出 JSON（会话、目录、模型、转录与错误）。需要人工回答时不会自动授权。`--approve-command <完整命令>` 仅允许完全相同的一次命令请求，其他命令仍拒绝；不要在命令中放密钥。

## Skill、MCP 与历史

Emergence 使用独立的 `EMERGENCE.md`（兼容小写文件名）保存个人与项目约定。个人文件位于 `%USERPROFILE%\.emergence\EMERGENCE.md`，也跟随自定义 `--home`；项目根和实际操作的子目录可各自提供规则，`EMERGENCE.local.md` 保存本地覆盖。默认兼容项目 `AGENTS.md`，`CLAUDE.md` 需显式启用。规则不能改变执行权限。

`/instructions` 查看实际来源与优先级，`/instructions reload` 刷新，`/instructions path "目录"` 纳入指定项目目录的规则。`/init`、`/init personal`、`/init local` 预览草案，再用 `/init apply` 按当前权限写入；已有文件保留原文并备份。每次模型请求前检查规则变化，两个项目独立加载。使用方式、配置与适用边界见 [E3 使用说明](../docs/experience-e3.md)，专项巡检为 `npm run inspect:full`。

Skill 沿用 Harness 发现规则，例如项目 `.agents/skills/<名称>/SKILL.md`；也可在配置 `skillDirs` 数组添加目录。模型通过 `skill` 工具加载正文；兼容性取决于具体 Skill 所需工具。

配置的 `mcp` 数组可添加本地 stdio 服务，保留其他配置字段：

```json
{
  "serverName": "example",
  "transport": "stdio",
  "command": "你的可执行文件",
  "args": ["参数"]
}
```

配置中的命令在启动时执行。当前没有 MCP 安装器或 HTTP 管理界面。

会话位于 `%USERPROFILE%\.emergence\sessions`，采用 Harness JSONL。可从同一项目运行 `emergence --resume <id>`；恢复不自动重放未完成工具，不恢复此前外部进程。恢复保留原模型，显式 `--model` 可以覆盖。

## 开发与巡检

执行权限已支持每窗口独立切换：`Shift+Tab` 循环切换计划、询问、自动编辑和自动执行；`/permission` 打开方向键/Enter 菜单，`Ctrl+P` 可在等待确认时输入命令。各窗口固定独立工作。默认自动编辑，自动执行仅放行项目编辑和显式允许规则，未知工具仍需确认。

确认新增“本会话允许相同操作”，仅覆盖同代理、目录和完整参数，切换模式或重开会话会撤销。`/permission revoke` 撤销许可；`/permission rules` 查看规则。启动可用 `emergence --permission plan`。旧自定义快捷键保留，`/keys` 查看实际映射；模式、规则、继承与适用边界见 [E2 使用说明](../docs/experience-e2.md)。`npm run inspect:full` 执行权限专项巡检。

```powershell
npm ci
npm run build
npm run dev -- "M:\你的项目"
npm run inspect:local
```

项目内锁定 Node 26.13.0，入口优先使用它，不修改系统 Node；最低要求为包含安全修复的 Node 26.12.1，所需 FFI 标记由入口提供。本地链接安装需要保留当前工程目录，移动后需重新链接。

`npm run inspect:security` 查询 npm 官方已知漏洞，并检查本机已保存凭据是否出现在源码、产物、记录或用户状态中；不输出密钥值。没有保存凭据的干净环境明确报告未做密钥比对。

同一配置目录下，同一项目的工作台只能由一个进程持有；不同项目可以并行启动，同一已打开的会话及其子代理不能在另一实例重复恢复。退出或进程终止后释放占用。每次启动使用独立临时 Harness profile，持久配置继续写在涌现配置目录。

`/model` 只修改当前窗口和会话的模型选择，不改写共享 `config.json` 的默认模型或覆盖外部新增配置。默认模型可在 `emergence config` 显示的文件中修改。配置和加密凭据更新采用跨进程互斥。

`npm run inspect`、`inspect:local` 和 `inspect:full` 使用同一当前版本矩阵，包含构建、单元/Harness、模型配置、故障恢复、独立窗口与终端交互。结果在上级 `artifacts/full-audit-日期/`；不触发打包、安装或发布。`test:personalization`、`test:workspace` 和 `test:independent-windows` 可单独验证对应流程。旧阶段报告仅供追溯，不作为发布门禁。

历史跨窗口验收记录仍保留在 artifacts 和阶段报告中，但不作为当前产品能力承诺；该功能已于 2026-11-16 移除。

第一阶段渲染器对照原型已退出正式源码，现有 TUI 回归直接验证产品实现。物理中文输入法候选框、其他终端和长期性能验证仍需后续覆盖。多窗口工作台需要交互终端，`--print` 保持单会话自动化入口。

## 角色与历史任务

/core roles 查看内置 KIM 治理职责，/roles 查看单会话计划可用角色。它们不再用于分配窗口。/tasks 保留本窗口计划及历史执行记录；旧协作阶段报告仅作开发历史参考。

## 工作流入口（E5）

Ctrl+R 或 `/history` 搜索当前会话输入历史，Enter 只回填草稿；`/model` 搜索并选择模型，`/roles` 查看单会话计划可用角色。F4 或 `/tasks` 搜索任务，Enter 看详情，右方向键进入执行窗口。命令候选显示时 Tab 补全且不执行，Esc 关闭选择器并保留草稿。重启后从已有会话日志恢复历史。详见 [E5 使用说明](../docs/experience-e5.md)，专项巡检为 `npm run inspect:full`。

## 内置任务规划（核心整合第三阶段）

自然语言任务按需进入直接、轻量或结构化规划路径。复杂任务先查询实际能力、读取来源并形成目标与验收计划，再进入原有权限和执行流程；不会自行开窗口或切模型。`/plan` 查看当前方案、缺口、取舍与能力绑定，`/capabilities` 查看实际可用资源，`/tasks` 查看真正的派发执行记录。计划不是完成证明。

需求分析由宿主保存编号与版本，后续计划引用需求编号，避免改写措辞时反复累加约束。“继续”会继承已有要求；新增建议不自动成为授权。旧计划存储首次升级前会生成 v1 备份，旧方案需要重新分析后派发。协议、兼容和验收范围见 [3A 需求契约报告](../docs/iteration-20261108/phase3a-report.md)。

`/core off` 可关闭规划与观察。默认规划前原生读取上限 12 次、计划修订上限 4 次；配置项 `core.planning` 可调整。方案按项目与会话保存，不自动写入长期记忆。使用和验证边界见 [第三阶段报告](../docs/core-integration-phase3-report.md)，运行 `npm run inspect:full` 做巡检。

## 可靠执行与中断恢复（核心整合第四阶段）

模型可把通过检查的计划提交为持久任务图；空闲时也可 `/plan run`，`/tasks` 查看真实进度。受管任务同项目串行，契约任务验收后释放依赖。重启不会自动重放中断任务。

`/recover` 列出待恢复任务，`/recover inspect <ID>` 核对事实；`/recover retry <ID> "核对说明"` 经原生确认后创建新尝试，`/recover keep <ID> "核对说明"` 保留已核对结果、不重做。说明至少 8 字；弹窗 Enter 默认取消，方向键选择后 Enter 确认，Esc 取消。旧跨窗任务不可重新派发；请在对应窗口重新提交独立任务。费用和 Token 未取得可靠数据时显示未知。

SQLite 台账只覆盖受管任务，不承诺外部操作只发生一次。迁移、回退和完整边界见 [第四阶段报告](../docs/core-integration-phase4-report.md)。巡检命令：`npm run inspect:full`。

## 审查验证与记忆（核心整合第五阶段）

`/audit show <ID>` 和 `/audit history <ID>` 保留历史审查与验证证据查看。跨窗口的 `/audit run` 已移除，不会自动创建审查窗口。当前会话仍可读取产物、运行获准的检查，或使用原生子代理进行审查；不能只凭模型文字宣称验证通过。

`/memory propose project fact "内容"` 创建候选，`/memory approve <ID>` 预览批准。支持 `show`、`search`、`correct`、`history`、`rollback`、`forget`；Enter 默认取消，方向键选择后 Enter 确认。会话与项目隔离，个人层只共享明确批准的偏好；策略仅存建议，不自动改规则。遗忘不删除已有聊天和外部服务数据。

本地记忆独立工作，`/memory status` 查看外部依赖边界。使用说明、安全限制和验证记录见 [第五阶段报告](../docs/core-integration-phase5-report.md)，巡检：`npm run inspect:full`。

## 原生数据分析与交付（Code/Data 第五阶段）

直接用自然语言指定项目内数据文件和分析目标，无需安装或点名 Skill。内置方法覆盖显式清洗、指标双路复算、关联对账、完整人口留存、严格时序漏斗、可加总指标变化贡献、二元 A/B 实验和日序列基线评估。

每次分析在配置目录 `core/data-runs/<运行ID>/` 生成输入快照、中文 HTML 报告、CSV、SVG、计算记录和可重放脚本，不修改源文件。`replay.py` 在安装同目录 `requirements.txt` 的 Python 环境重新计算并比较结果；更改输入、已确认口径或交付产物后，旧验收证据失效。

数据初始化使用 `emergence data-init --python "Python 3.14 的 python.exe 路径"`；首次需要 Windows x64 的 Python 3.14。下载仅接受固定版本和 SHA-256 的 wheel，完整检查后启用。`--offline --wheel-dir "离线 wheel 目录"` 支持断网初始化；`--home` 可指定隔离配置，`--force-data-init` 在新目录重建。环境存放在该配置目录的 `runtimes/data/`，升级或卸载应用不会删除它。源码脚本 `scripts/setup-data.ps1` 是同一命令的便捷入口。旧源码 `.data-venv` 在未配置托管环境时继续兼容，候选发行目录不会查找或复用开发环境。

报告的“输入质量与范围”列出输入行数、重复行、每列空值、仅含空白的文本和不同值数量。空值不等于零，空白不自动修剪，重复行不自动删除；需要清理时明确方法参数。示例任务：“分析项目里的 sales.csv，先说明数据质量，再按月份汇总销售额（元），导出报告；原始文件保持不变。”

项目业务口径包含公式、粒度、分子分母、过滤、时区、单位、来源与版本；长期保存需要用户明确确认，没有确认的本次定义会标记假设。计划模式允许原生只读计算，不能借此保存确认口径或执行任意脚本。当前限制：8 MiB 输入、1万行、128列、10万单元格、30秒固定计算；远程数据库专用适配仍未接入。方法边界与测试见 [第五阶段报告](../docs/code-data-phase5-report.md)。

## Code/Data 与运行诊断

直接在任意独立窗口提交编程或数据任务。例如先在一个窗口修复代码，再自行在另一个窗口指定结果文件做数据分析；系统不会代为分派窗口。原生数据交付的哈希、输入版本检查和 replay.py 复算保留，修改输入后须重新计算，不能复用过期证据。

若看到“模型输出达到 Token 上限，本轮未完成”，本轮确实没有正常结束；命令行 `--print` 返回非零退出码。可在模型配置工具的高级参数调整输出预算，或缩小当前任务后继续。系统不会因为截断而自动重跑可能产生副作用的操作。`toolPolicy.deny` 中的 `emergence_data_*` 或 `emergence_code_*` 可分别关闭领域工具，重启会话后生效，通用工具和外部 Skills/MCP 仍遵循各自权限。

本机联合验收、重复实网样本和未通过项见 [第六阶段报告](../docs/code-data-phase6-report.md)。小样本结果不代表所有模型和任务都能稳定完成；没有打安装包或发布。
