# 本地运行、数据环境与升级

适用于 2026-11-16 第五阶段。首版验收范围是 Windows 11 x64。本地源码运行继续保留；候选目录用于独立运行和隔离安装验证，尚未向 GitHub/npm 发布。当前无需替换你已经配置好的 `emergence` 命令。

## 两种入口，一套运行逻辑

| 入口 | 运行环境 | 用途 |
| --- | --- | --- |
| 当前工程的 `emergence` / `emergence/bin/emergence.cjs` | 工程内固定 Node 26.13.0、锁文件依赖及构建结果 | 继续本机开发与调试 |
| 本地候选目录的 `emergence.cmd` | 同目录 `runtime/node.exe`、`app/dist` 及锁定生产依赖 | 验证不带源码、无全局 Node 的运行与升级 |

候选目录由 `npm run release:prepare`、`npm run release:pack -- --directory-only` 生成，位置记录在 `artifacts/phase6/release-path.json`；这里的 `phase6` 是历史脚本的产物目录名，不代表已开展第六阶段发布。上述命令应在 `emergence` 工程目录、固定 Node 环境下运行。它不会安装到当前用户，也不会改 PATH。

首次打开仍先进入首页；提交任务后进入对话。要恢复工作台，使用 `/continue` 或显式恢复入口；旧任务不会因为恢复布局而自动重放。

## 运行前置条件

- Windows 11 x64，原生模型配置工具需要 .NET Framework 4.8。
- 候选目录自带 Node，不需要全局 Node/npm；源码运行使用工程内固定的 Node。
- 模型由使用者通过原生 `model-config` 工具配置。候选目录没有作者的配置、密钥、会话或项目数据。不同模型服务的可用性需要单独验证。
- **仅数据计算需要 Python 3.14 x64**。它是本机前置依赖，不随当前候选目录分发。没有 Python 时 CLI、原生配置和普通编程工具仍可使用，`doctor` 对数据能力给出提示。

在候选目录中运行：

```powershell
.\emergence.cmd --help
.\emergence.cmd doctor --json
.\emergence.cmd model-config
```

诊断不发模型请求；提示“凭据库存在”不代表某个模型的密钥绑定或外部服务已验证。

## 初始化数据环境

把 `--python` 替换成本机 Python 3.14 的实际路径：

```powershell
.\emergence.cmd data-init --python "C:\Python314\python.exe"
.\emergence.cmd doctor --json
```

使用隔离配置时，两条命令都加同一个 `--home "D:\EmergenceData"`。源码工程也可使用同一 CLI；`scripts/setup-data.ps1` 只是这条命令的薄包装，没有第二套安装实现。

初始化读取内置依赖锁，只接受指定版本及 SHA-256 的二进制 wheel，不在本机编译依赖。检查包括解释器版本、依赖关系、五个包的准确版本及真实导入。哈希模式采用 pip 的 `--require-hashes` 和 `--only-binary=:all:`，见 [pip 安全安装说明](https://pip.pypa.io/en/stable/topics/secure-installs/)。

离线安装时，先在可联网机器准备 `app/dist/data/runtime-lock.json` 列出的全部 wheel，保持文件名和内容不变，再执行：

```powershell
.\emergence.cmd data-init --python "C:\Python314\python.exe" --offline --wheel-dir "D:\wheel-cache"
```

缺少或哈希不匹配的 wheel 会失败，不切换现有环境。重复初始化会检查并复用环境；确需重建时加 `--force-data-init`。

## 数据与版本放在哪里

配置目录取 `--home`、`EMERGENCE_HOME` 或默认 `%USERPROFILE%\.emergence`。数据环境位于其中的 `runtimes/data/<依赖锁摘要前缀>/<UUID>`，活动指针记录完整依赖锁摘要。

每次重建都在新的永久目录完成，验证成功后才原子切换 `active.json`；已有指针先备份为 `active.backup-<UUID>.json`，旧环境保留。失败只清理本次新建的目录，现有指针和环境不动。不同依赖锁的环境并存，不会因为应用升级就原地替换依赖。

Python 虚拟环境不宜搬家。移动配置目录、迁移机器或删除基础 Python 后，应在目标位置重新初始化；不要只复制虚拟环境。这里遵循 [Python venv 的可移植性说明](https://docs.python.org/3/library/venv.html)。当前兼容已有源码工程的 `.data-venv`，但候选目录绝不回退到作者的开发环境；损坏的活动指针也不会被默默忽略。

Data worker、分析实现、依赖锁、探测脚本及许可证随 `app/dist/data/` 一同交付。运行前核对资源清单与 SHA-256。源码与参考仓库不参与候选目录运行。

## 升级、迁移、卸载

当前测试只安装到隔离目录并使用 `-NoPath`，没有更改真实用户 PATH。以后需要安装时，在候选目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallRoot "D:\EmergenceApp" -NoPath
```

升级使用新版目录中的同一脚本与相同 `InstallRoot`。先验证清单，再复制完整新版本、复核后切换入口；旧版本保留。失败的校验不会替换旧入口；复制过程失败会清理本次暂存目录。相同版本号不会覆盖不同的既有内容，持续试用的版本应明确递增。

配置迁移沿用既有 schema 迁移流程：先备份，已是当前版本时不重复改写；损坏或未知版本明确报错。升级保留配置、加密凭据、会话、模板和独立的数据环境。DPAPI 凭据绑定当前 Windows 用户，不能当作跨机器可共享的密钥文件。

卸载使用安装目录自己的 `uninstall.ps1`，先关闭运行中的实例。它仅处理标记为 Emergence 所有的应用目录及自己的 PATH 项，不删除项目与用户配置目录；数据环境因此继续保留。不要把项目或用户资料放进应用版本目录，也不要直接递归删除不认识的目录。

## 本轮验收边界

已经使用新的隔离配置目录、精简 PATH、没有源码/开发虚拟环境的候选目录验证真实 Harness、KIM、Code、Python 计算和报告，以及原生配置服务、升级/卸载与失败保留行为。模型响应用本地受控服务，不包含付费外网模型调用。

这是本机隔离验收，不是重新安装 Windows 的虚拟机或另一位用户的独立试用。macOS/Linux、公开安装包、代码签名及公开发布仍属于后续工作；当前目录级 SHA-256 校验也不等于发布者身份签名。
