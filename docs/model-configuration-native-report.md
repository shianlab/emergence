# 原生模型配置工具交付

日期：2026-10-30。按用户最终要求，窗口及界面控件全部采用 Windows Forms，入口为项目根目录 `涌现模型配置.exe`。没有 WebView、HTML 界面或浏览器启动。

## 实现

- 原生 TabControl、Button、ComboBox、TextBox、NumericUpDown、CheckBox 和 Label；白底、约 520 逻辑像素宽，内容决定高度。保留定稿“涌现”字形、模型库/分配双页签和折叠设置。
- 8 家国内厂商的 15 个 API/Coding 预设沿用现有官方配置，表单自动填写连接字段。编辑、保存、连接测试、删除、全局/角色/窗口编号默认分配均通过同一配置服务实现。
- 桌面程序约 73 KB，使用 Windows .NET Framework 4.8；复用项目随附的 Node 和配置代码，不另外打包浏览器或一套 Node。它是随项目的小工具，移动时需保留完整项目或发行目录。
- 双击启动时隐藏启动自己的配置后端；关闭窗口通知后端结束，异常退出时管道 EOF 同样触发后端关闭。
- TUI 打开时通过私有 stdin 管道传入临时服务会话，令牌不出现在进程命令行。窗口重开/聚焦不新建工作台；关闭窗口保留 TUI，退出 TUI 时关闭对应工具。
- 当前构建不再提供或打包旧的网页资源，本机只保留经过鉴权的 JSON 业务接口。模型数据与 DPAPI 文件格式保持兼容。

## 实测

原生界面验收使用隔离项目与严格本机供应商服务，无个人配置写入：

1. 从原生厂商下拉框选择 MiniMax 普通 API，自动填写 `MiniMax-M2.7` 等字段。
2. 展开系统控件表单，将地址替换成本机测试服务，填入独立的虚拟 Key，点击测试连接成功。
3. 点击保存后模型列表增加；磁盘保存 `minimax-api`，Key 通过现有 DPAPI 服务保存。
4. 分配页将第二窗口选择为 `minimax-api`，点击应用成功。
5. 同一窗口通过实际 Harness 发送请求，收到 `MiniMax-M2.7` 对应回复，会话 ID 保留。证据：`artifacts/model-configuration/native-ui-runtime.json`。

自动化：`npm test` 158 / 158 通过；模型配置专项 10 / 10 通过；构建和类型检查通过。JSON 接口测试明确检查根路径及旧 HTML/JS/CSS 入口均返回 404，接受原生客户端发送的 UTF-8 JSON。

`npm run inspect:model-config` 18 / 18 路线通过，并确认重启 CLI 可读取保存的加密 Key；首页入口与 CLI 端到端回归通过。原生程序已打开时再次构建也通过，未变更的二进制会复用，避免占用中的 exe 被重复写入。

`npm run test:model-config:native` 已通过：GUI 子系统标记、附加打开、再次打开、stdin EOF 退出、独立窗口退出、隐藏后端退出、未操作时配置文件不变。结果见 `artifacts/model-configuration/native-lifecycle.json`。独立窗口使用 Windows 关闭按钮完成验收。

交付时直接启动项目根目录 exe，正确显示个人原有 `deepseek / deepseek-flash` 和“已配置 Key”，未修改个人配置或发起模型请求。实际原生截图见 `artifacts/model-configuration/native-desktop.png`。旧网页测试窗口与隔离后端已退出，交付窗口保持打开。

后端真实供应商边界保持原巡检结论：DeepSeek 已通过真实官方接口与 CLI；其他厂商本地链路通过，真实权限需对应 Key。本轮没有重复消耗外网模型额度。
