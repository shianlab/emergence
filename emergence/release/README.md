# 涌现 · Emergence 1.00

Windows x64 发行包，内含 Node 26.13.0 与锁定生产依赖。无需预装 Node/npm。推荐 Windows 11 + Windows Terminal；原生模型配置需要 .NET Framework 4.8。发行仓库：https://github.com/shianlab/emergence

## 启动或安装

直接运行本目录 `emergence.cmd`；安装到当前用户：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

重开终端，进入项目目录并运行 `emergence`。默认安装在 `%LOCALAPPDATA%\Emergence`，不需要管理员权限。可加 `-InstallRoot "D:\Apps\Emergence"` 或 `-NoPath`。不要拆开 `app`、`runtime` 和清单文件。

首次输入 `/model-config`，或双击本目录的“涌现模型配置.exe”，添加模型、API 地址与密钥。配置工具为 Windows Forms 原生界面，关闭独立窗口后退出隐藏服务。各窗口独立选择模型，没有主窗口和跨窗口控制。

配置、凭据、历史及模板默认在 `%USERPROFILE%\.emergence`，可由 `EMERGENCE_HOME` 或 `--home` 指定。密钥使用当前 Windows 用户的 DPAPI 加密。发行包不包含开发者配置。API 服务与额度由用户提供。

## 常用操作

输入 `/` 查找命令；Enter 发送，Shift+Enter 换行，Ctrl+P 搜索。F2/F3 分屏，Tab 切换，F6 关闭窗口。Shift+Tab 切换权限；审批用方向键与 Enter，Esc 取消。Ctrl+C 停止，空闲时连续两次退出。

`/continue` 继续工作台，`/sessions` 查看历史，`/skills`、`/mcp` 查看扩展能力。恢复不会自动重放执行操作。多个独立窗口写同一项目需协调，建议使用 Git worktree。

## 数据环境

准备 CPython 3.14 x64，指定实际路径：

```powershell
.\emergence.cmd data-init --python "C:\Python314\python.exe"
.\emergence.cmd doctor --json
```

初始化显式下载锁定且校验哈希的 wheel，在配置目录 `runtimes/data/` 建立独立环境。失败不替换旧环境。离线可加 `--offline --wheel-dir "D:\wheels"`。升级应用可以复用兼容数据环境；不要从另一台机器复制虚拟环境。

## 升级与卸载

解压新发行包，执行新的 `install.ps1`，选择相同目录。安装器校验、部署完整版本后切换入口，保留旧版本和用户数据。回退可重新安装旧版。

关闭实例后卸载：

```powershell
& "$env:LOCALAPPDATA\Emergence\uninstall.ps1"
```

自定义目录运行其卸载脚本。卸载移除应用与自己的 PATH 项，保留项目、配置、加密密钥、历史和数据环境。

## 排查与许可

`emergence --version` 查看版本；`emergence doctor --json` 检查环境；分享诊断前核对隐私。401 核对密钥和端点，429 等待服务恢复。`--fresh` 可开始新工作台，原会话保留。

macOS/Linux/ARM64 未发布。应用审批不是系统沙箱。发行物未做商业代码签名；ZIP 的 SHA-256 与 `manifest.sha256.json` 用于完整性检查。自有代码 MIT，第三方许可随组件保留；Node 许可在 `licenses/Node-LICENSE.txt`，依赖清单在 `sbom.json`。

完整文档：https://github.com/shianlab/emergence/blob/main/docs/installation.md
