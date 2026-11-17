# 安装、升级与卸载 / Installation

Emergence 1.02 的发行物为 Windows x64，新增签名更新、重试续传和事务维护。推荐 Windows 11、Windows Terminal、PowerShell 5.1 或更新版本；原生模型配置工具需要 .NET Framework 4.8。发行包自带 Node 26.13.0 和生产依赖，不需要 Node/npm 或管理员权限。Git 仅在使用 Git 相关功能时需要。

## 一行安装

```powershell
irm https://raw.githubusercontent.com/shianlab/emergence/main/install.ps1 | iex
```

安装到 `%LOCALAPPDATA%\Emergence`，加入当前用户 PATH，并更新本次 PowerShell 会话的 PATH。之后进入项目目录运行 `emergence`；其他已打开的终端可能需要重开。首次启动输入 `/model-config` 配置服务。

脚本验证官方稳定版签名清单，再从版本化 GitHub Release 下载 ZIP，校验字节数、SHA-256 和压缩包路径。安装器验证完整文件和实际启动，随后切换入口。下载有超时、重试及可验证的续传缓存；失败可直接重试，不必手动删除旧版。它不会把源码当安装包，也不包含作者的用户配置。

网络需要能访问 `raw.githubusercontent.com`、`github.com` 及 GitHub Release 下载域名。下载失败可改用官方 Release 手动下载，不要跳过校验。

## 先审查，再执行

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/shianlab/emergence/main/install.ps1 -OutFile .\install-emergence.ps1
Get-Content .\install-emergence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-emergence.ps1
```

`ExecutionPolicy Bypass` 仅作用于该子进程，不修改系统执行策略。指定版本、目录或跳过 PATH：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-emergence.ps1 -Version 1.0.2 -InstallRoot "D:\Apps\Emergence" -NoPath
```

`-NoPath` 时通过 `D:\Apps\Emergence\bin\emergence.cmd` 启动。

## 手动与离线安装

1. 在 [v1.0.2 Release](https://github.com/shianlab/emergence/releases/tag/v1.0.2) 下载 **Emergence-1.0.2-win32-x64.zip** 和同名 `.sha256` 文件。GitHub 自动提供的 Source code ZIP 是源码，不是可直接运行的发行包。
2. 计算 ZIP 哈希，和 `.sha256` 中的值比较：

   ```powershell
   Get-FileHash .\Emergence-1.0.2-win32-x64.zip -Algorithm SHA256
   ```

3. 用 Windows 自带 `tar -xf` 解压，在发行目录运行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

也可直接运行发行目录中的 `emergence.cmd`，不修改 PATH。`runtime`、`app`、清单及许可证须保持完整。离线安装不需要下载 npm 包；调用远程模型仍需网络。

SHA-256 用于完整性检查。在线安装和更新还验证独立的发布者清单签名；手动下载只比较摘要不等同于签名验证。原生 EXE/脚本尚未做商业代码签名，Windows 可能显示来源提示。请核对仓库和校验结果，不建议关闭系统防护。

## 数据分析环境

安装 CPython 3.14 x64，然后指定实际解释器：

```powershell
emergence data-init --python "C:\Python314\python.exe"
emergence doctor --json
```

应用安装不自动安装 Python。数据初始化在配置目录 `runtimes/data/` 创建独立环境，核对锁定 wheel 的 SHA-256；失败保留旧环境。已有 wheel 目录时可用 `--offline --wheel-dir "D:\wheels"`；重建加 `--force-data-init`。

## 更新与回退

**1.00/1.01 用户先执行一次上方安装命令，或用新包的 `install.ps1` 安装到原目录。** 旧版没有更新检测代码，不会自行弹出迁移通知。自定义目录继续传入 `-InstallRoot`，原来使用 `-NoPath` 的用户迁移时继续指定。

1.02 起，启动及持续运行时后台检查，缓存默认 6 小时。检测到新版只提示，由用户选择安装；网络不通不阻塞任务。TUI 用 `/update`，也可使用：

```powershell
emergence update --check
emergence update
emergence installation status
emergence rollback
```

更新在新目录验证后切换，下次启动生效，当前任务继续使用旧版。修复用 `emergence repair --source "完整同版发行目录"`；入口无法启动时重新运行完整包的 `install.ps1`。回退只回退应用，不回滚用户数据，需要存在健康且兼容的上一版本。便携和源码入口不会自动覆盖目录。

清理保留当前、上一份可用版本及仍被使用的版本。占用不明、未知文件及旧式启动器目录不会强制删除；可运行 `emergence installation cleanup` 检查可清理内容。首次签名通道有效期与维护方式见[更新服务说明](structure/update-maintenance.md)。

配置、密钥、历史和数据环境与应用文件分离；迁移保留备份，不覆盖无法识别的配置版本。不要手动删除运行中的版本文件。

## 卸载

关闭实例后运行：

```powershell
& "$env:LOCALAPPDATA\Emergence\uninstall.ps1"
```

自定义目录请运行该目录下的卸载脚本。卸载移除应用与自己的 PATH 项，保留项目、配置、历史、密钥和分析环境。如需删除用户数据，请自行备份后明确处理。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 `emergence` | 重开终端；检查用户 PATH，或直接运行安装目录 `bin\emergence.cmd` |
| 下载或校验失败 | 从官方 Release 重新下载 ZIP 与摘要；不要跳过校验 |
| 提示实例运行中 | 关闭实例后重试，不手动删除在用文件 |
| 模型 401 / 429 | 核对 API 地址和密钥，或等待限流恢复 |
| Git 未检测到仓库 | 当前目录不是 Git 仓库；普通任务可继续，Git 工作树需实际仓库 |
| 数据工具未就绪 | 检查 Python 版本/架构，执行 `data-init` 和 `doctor` |

诊断：`emergence doctor --json --output diagnostic.json`。反馈请提供系统、终端、`emergence --version` 和最小复现，分享前检查隐私。

For English users: run the one-line PowerShell installer above, then `emergence` and `/model-config`. Use `-InstallRoot` / `-NoPath` for custom installation. Downloads are hash-checked; no admin or Node/npm prerequisite. Python 3.14 x64 is optional for data tools. Uninstallation preserves user data. Windows x64 is the only released platform.
