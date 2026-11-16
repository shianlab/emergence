# E2：执行模式与权限

本阶段在本机源码版实现，安装包和发布继续后置。重启 `emergence` 使用已构建版本。

## 使用

- `Shift+Tab` 循环切换当前窗口的计划、询问、自动编辑、自动执行。
- `/permission` 打开菜单，方向键选择、Enter 应用、Esc 返回。等待工具确认时可用 `Ctrl+P` 输入该命令。
- `/permission plan|ask|edit|auto` 直接选择。标题显示每窗口权限；切换保留历史、模型和草稿。
- `Tab` 下一窗口，`Ctrl+Shift+Tab` 上一窗口。部分终端会截获后一组合，可用 `/focus` 或 `/bind previous F9`。原自定义 Shift+Tab 保留，新动作使用空闲备用键，`/keys` 查看实际映射。
- `emergence --permission plan` 按计划模式启动；恢复工作台时只覆盖焦点窗口。新模板统一采用启动模式或配置默认值。

| 模式 | 实际执行行为 |
|---|---|
| plan 计划 | 结构化读文件、搜索、技能加载、问答和任务状态读取可用；禁止所有文件写入、任意 Shell、未知 MCP/扩展工具及执行型派发。内部计划文件写入例外尚未启用。 |
| ask 询问 | 读取正常；写入、命令、未知工具需要确认。派发本身可用，执行窗口和子代理仍受相交权限约束。 |
| edit 自动编辑 | 项目根内 write/edit 自动；项目外写入、命令及未知工具需确认。 |
| auto 自动执行 | 项目内编辑和显式 allow 规则命中的操作自动；未知操作仍确认，ask/deny 保留。采用确定性规则，没有模型风险分类器。 |

默认 `edit`，保留原有项目内编辑体验。旧版默认直接执行的未知 MCP/扩展工具，现在需要确认。原 `shellMode` 表示本机或 Harness 沙箱后端，和执行权限是独立配置；即使选择 sandbox，也必须满足 Emergence 权限和 Harness 原有限制。

## 许可和规则

确认选项增加“本会话允许相同操作”，精确限定到实际代理、工作目录、完整参数和物理目标路径。只存内存，不写成永久规则；新建/恢复会话、切换模式、修改规则、关闭或 `/permission revoke` 都撤销。显式 ask/旧 confirm 规则只能逐次确认。

持久规则入口：

```text
/permission rule allow pwsh command "npm test"
/permission rule deny write path "secrets/**"
/permission rule ask edit path "config.json"
/permission rules
/permission remove 1
/permission default ask
```

允许规则仅在 auto 模式自动放行。Shell 按完整命令比较，没有前缀白名单或命令拆词授权；其余完整参数仍受会话许可精确比较。工具名支持末尾 `*`；路径支持字面文件或末尾 `/**`，相对路径相对于授权窗口的项目根。配置文件规则还支持 `agent` 字段，精确匹配真实 Harness Agent ID，不读取模型声称的角色名。

规则可在 `config.json` 的 `permissions: { defaultMode, rules }` 查看。优先级为计划模式硬限制和 deny → 显式 ask → 会话许可/模式默认。旧 `toolPolicy.deny/confirm` 继续生效。`/settings reload` 在所有窗口空闲时载入新规则并撤销旧许可，不重置各窗口已选模式。全局规则写入使用原跨进程配置锁，避免覆盖其他配置更新。

旧配置缺少 permissions 时在内存补齐默认值。`emergence config migrate` 显式保存迁移，并先产生原文件的逐字节备份。工作台按窗口持久化模式，恢复不重放任务，也不恢复会话授权。

## 执行约束

工具预检查、审批响应和最终执行检查使用同一套决策；模式、配置版本、实际代理、参数或物理路径变化后，旧调用失效。目录判断解析符号链接/Windows junction；新文件也解析最近存在的父目录，拒绝设备路径和 NTFS 数据流路径。

原生子代理使用真实运行时 ownership 归属。独立窗口派发记录来源权限快照，执行时同时检查目标窗口、派发时上限、来源当前权限。主任务结束后仍存活的子代理继续保留原任务约束。来源模式变化会取消相关窗口的旧确认。Harness 的固定 delegation 审批仍保留，不能用 Emergence 许可越过它。

切模式先撤销旧许可和待处理确认。已开始的工具运行期间显示“切换中”，阻止该窗口新工具，待当前工具返回后完成切换。已经发生的写入、已启动的外部/后台进程不会自动回滚。这是 Agent 工具授权层；不是操作系统级文件沙箱，不能保证抵抗外部进程同时替换文件链接，也不约束用户明确执行的工作台管理命令或受信任扩展初始化代码。

## 验证

`npm run inspect:e2`：类型检查、构建、8 项实际 Harness/权限测试、8 项原生 UI 检查、9 项真实 ConPTY 检查。证据：`artifacts/experience-e2/inspection.json`、`native.json`、`terminal.json`。

另运行 54 项常规回归、E1 六组专项巡检，以及原模型协议/Skill/MCP 工具链、协作和个性化终端流程。模型由本地 HTTP/SSE 服务模拟，真正使用 Harness、文件工具、PowerShell 与终端；未调用付费模型。物理键盘快捷键被宿主截获的差异与长期负载不由这轮专项测试覆盖。

下一阶段 E3：Emergence 独立身份与 `EMERGENCE.md` 分层加载、来源展示和初始化。
