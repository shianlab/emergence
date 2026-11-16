# 设计

目的：统一管理模型连接与窗口分配，配置直接服务涌现运行时。

视觉（2026-10-30 用户最终修订）：配置工具采用 Windows Forms 原生系统控件，约 520 逻辑像素宽，窗口高度随内容适配，超屏时页内滚动。背景白色，黑灰文字与系统控件边线，Microsoft YaHei UI 正文。顶部“模型库 / 分配”双页签，无侧栏和大标题；模型按需编辑，默认规则折叠。手写像素轮廓以深灰呈现在白底。TUI 深色定稿不变。

结构：Windows Forms WinExe + Node loopback JSON 配置服务。全部界面使用系统控件，不提供 HTML/JS/CSS，也不启动 WebView 或浏览器。项目/发行目录提供“涌现模型配置.exe”；复用项目随附 Node 与 Windows .NET Framework 4.8。TUI 通过 stdin 管道传会话并控制聚焦/关闭；独立启动时由 WinExe 隐藏启动后端，关闭小窗或管道 EOF 时结束后端。服务绑定 127.0.0.1 随机端口，继续校验 Host、Origin、Bearer、JSON 与大小，不启用 CORS；令牌不写入命令行，Key 不回显。

配置复用 config.json / modelSchema / updateConfig 租约和原子写入。Windows 密钥复用 DPAPI，显式环境变量仍优先。配置仅写引用，不读回密钥。指纹校验阻止旧编辑覆盖并行修改。

运行时使用 Harness settings 对 llm-pi-ai 的现有动态路由更新机制，不新增推理适配器。应用前持有工作台配置互斥，并检查空闲/协作/历史能力；更新所有窗口配置快照，仅连接变化时重选实际 provider/model，修改默认规则时不重选。按窗口应用走原有 /model 路径。Harness 启动环境被冻结，因此对已配置模型的 CredentialProvider.resolve 添加可释放的局部装饰器，让 DPAPI 更新的环境值到达下一次请求；其他凭据引用和全部 OAuth/record 方法保持上游行为。CLI 向子进程只传已注入凭据的环境变量名，保持显式 shell 环境变量优先级；密钥不写入 profile。服务随 TUI 关闭；单独 CLI 模式只编辑共享配置，不控制其他进程。

参考：CC Switch 官方仓库 https://github.com/farion1231/cc-switch （连接字段编辑与测试）。不复制其代理、账户管理或多产品兼容范围。

验证：配置兼容/引用与冲突、JSON 会话边界、四协议测试与假成功拒绝、密钥不回显、真实 Harness 热更新及多窗口分配；原生 UI 完成新增/保存/连接测试/窗口应用，另验收附加重开、独立退出和隐藏后端清理。真实付费供应商测试由用户点击触发。
