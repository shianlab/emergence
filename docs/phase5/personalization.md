# 第五阶段使用指南

版本：0.0.5-phase5.1。直接在终端输入 `emergence`，默认恢复当前项目的工作台。

## 保存自己的工作方式

先分屏并为每个窗口选择项目、模型和协作角色，然后保存：

```text
/split right "M:\另一个项目" deepseek
/mode collaborate 1 2
/template save daily
/template list
```

以后在应用内输入 `/template load daily`，或直接启动：

```powershell
emergence --template daily
```

模板记录布局、可见/隐藏窗口、目录、模型配置 ID 和主控/执行者角色。它不包含密钥、会话 ID、草稿或旧任务。加载要求窗口、子代理和扩展操作空闲，创建全新的会话；协作默认暂停，输入 `/mode collaborate` 后才开始派发。原工作台先备份到配置目录的 `workspaces/*.before-template-*.json`，历史会话继续保留。任何项目目录或模型无效时，原窗口保留。

未显式传入窗口编号时，`/mode collaborate` 沿用模板保存的主控和执行者，不会因为当前焦点在执行窗口就交换角色。

`/template delete daily` 只删除该模板。模板与绝对项目路径绑定，跨机器使用前需要调整目录。

## 主题、快捷键和状态栏

```text
/theme dark
/theme amber
/theme light
/theme color accent #a78bfa
/theme reset
/keys
/bind close F10
/bind reset
/language en
/language zh-CN
/statusbar fields project,model,tasks,context
/statusbar off
/settings
```

这些设置立即应用于当前工作台，并保存到涌现配置目录的 `config.json`；其他已经打开的应用实例用 `/settings reload` 同步。快捷键冲突会拒绝保存。支持 F1–F12、Tab、方向键、Escape、PageUp/PageDown，允许 Ctrl/Shift 修饰；Ctrl+C 固定退出，Enter/Shift+Enter/Ctrl+A 留给输入框。`/keys` 列出可配置动作名称。

自定义颜色字段为 background、foreground、accent、border、muted、input、warning，格式必须为 `#RRGGBB`。语言设置覆盖工作台控件、状态和快捷键提示；模型回复、Harness 原始诊断和部分命令说明保持原语言。

## Harness 能力入口

| 入口 | 行为 |
| --- | --- |
| `/capabilities`、`/tools` | 查看真实注册的工具及能力状态 |
| `/skills`、`/skills <name>` | 按当前项目和会话作用域发现技能、查看正文 |
| `/skill <name>` | 将允许人工调用的技能加入本窗口下一步上下文，不自行唤醒模型 |
| `/skills add-dir "目录"` | 保存额外技能目录，重启后生效 |
| `/mcp` | 查看配置、连接状态和失败原因 |
| `/mcp enable <name>`、`disable <name>` | 空闲时连接或断开已配置的 stdio 服务，注册/卸载工具并保存设置 |
| `/permissions` | 查看本地工具禁用和确认规则 |
| `/permissions deny write` | 拒绝该工具；支持 `mcp__proof__*` 等末尾通配符 |
| `/permissions confirm write` | 所属窗口逐次确认该工具调用 |
| `/permissions allow write` | 删除同名规则；不会取消仍匹配的其他通配规则 |
| `/permissions reset` | 清空自定义规则，默认 ask-local 的 Shell 确认仍保留 |
| `/context` | 查看配置预算、事件数、待处理上下文、最后一条模型回执 |
| `/context note "补充内容"` | 持久加入本窗口下一步上下文，保持当前模型和历史 |
| `/context export "snapshot.json"` | 导出脱敏快照；目标文件存在时拒绝覆盖 |
| `/agents` | 查看本窗口活动代理，以及 Harness 持久目录中已结束的子代理 |
| `/agents show <id>` | 只读查看本窗口子代理最近事件，不重新运行它 |
| `/agents stop <id>` | 停止本窗口拥有的活动代理 |

MCP 的 `mcp` 配置示例：

```json
{"serverName":"local","transport":"stdio","command":"node","args":["M:/my-mcp/server.mjs"],"enabled":true}
```

添加服务或修改启动参数后重启；已有服务可在界面中启停。单个服务启动失败不阻断工作台，其错误显示在 `/mcp`。MCP 连接由应用管理，停用时断开连接、卸载工具、释放名称。

运行能力配置切换期间，新的任务、分屏和关闭窗口会暂时提示“设置正在更新”，完成后即可继续；Ctrl+C 和 `/exit` 仍可退出。正在启动的 MCP 也属于关闭流程，不会在退出后再次注册工具。

MCP 进程由整个工作台共享，服务 cwd 不随窗格切换；需要不同服务目录时，配置不同 serverName 与 cwd。

原生子代理沿用 Harness 的固定委派权限：需要额外审批的操作自动拒绝，由主会话处理。多窗口执行者仍有各自的交互审批。这两类执行方式的权限语义不同。

## 模型配置与历史

`/models` 展示协议、上下文/输出预算、密钥是否配置，以及可选的 capabilities.tools / capabilities.vision 声明。密钥值不展示。`/model <id>` 只改变当前会话下一轮的模型，不改共享默认模型、不清除历史；忙碌时拒绝切换。显式声明不支持工具/图像的配置，不能接收已有相应记录的历史，需先 `/new`。旧会话仍可恢复。

vision 声明传入 pi-ai 模型输入类型；tools:false 会禁止该窗口的工具执行。能力声明不等于服务商实测，不会自动转换不兼容的历史或探测任意网关。需要编码工具的模型应支持工具调用。新增/修改模型路由后重启；默认模型可用 `emergence config default --id <模型配置>` 设置。

首版保留 Harness 的上下文组装和标准工具，不提供手动清空/压缩历史命令，也没有额外的 ACP 后端。新增供应商仍按实际协议和模型能力验收。

## 扩展

启用随应用附带的实际示例：

```text
/extensions enable inspector
/x_inspector_project
/panel inspector.project
/extensions disable inspector
```

启用后还会注册模型工具 `ext_inspector_project_info`，读取调用窗口的项目条目、模型和会话信息。命令、面板和工具使用同一实现；运行计时器通过 effect 注册，停用时释放。

自定义扩展为显式配置的受信任本地 ESM 模块，导出 `activate(api)`。参考工程内 `examples/project-notes.mjs` 和 `src/app/extensions.ts` 的 ExtensionAPI：

```text
/extensions add notes "M:\my-extensions\project-notes.mjs"
/extensions enable notes
/x_notes_summary
/panel notes.summary
/extensions disable notes
```

命令固定使用 `/x_<扩展ID>_<名称>`，面板使用 `<扩展ID>.<名称>`，工具使用 `ext_<扩展ID>_<名称>`，避免覆盖内置命令和工具。`api.current()/panes()` 返回目录、模型和会话绑定，不提供凭据；工具仍经过所属窗口的权限检查。

`api.effect()` 和 activate 返回的清理函数归应用管理。停用会中止 signal、移除入口、执行清理并等待在途任务退出；初始化抛错会回滚已登记的入口和资源，其他窗口继续工作。异步 activate、命令、面板、工具必须响应 AbortSignal；模块内部创建的资源必须登记清理。面板是按命令读取的快照，重新打开可刷新。

可以从另一个窗口执行 `/extensions disable <id>` 中止该扩展正在等待的命令或面板。模型工具的回调接收实际调用代理的目录、模型和会话：子代理切换项目或模型后，不会继续沿用主会话的绑定。

扩展在同一个进程运行，具备当前用户的本机权限；这不是恶意代码隔离。程序不自动加载项目目录中的扩展。修改模块代码后重启，以避开 Node 的模块缓存；启停会释放资源，不会清空模块缓存。
