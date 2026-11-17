# 安装与发行维护边界

本页适用于安装改进第一、二阶段。产品仍是独立多窗口；安装更新不属于 Harness、KIM 或模型工具调用。

## 当前职责

| 入口 | 职责 |
| --- | --- |
| 根 `install.ps1` | 无 Node 的独立引导脚本；环境检查、下载缓存锁、受限重试/续传、ZIP 安全验证、解压、调用离线安装器与阶段日志 |
| `emergence/release/manage.cjs` | 唯一命令适配入口，校验参数、输出结果；不再持有第二份安装逻辑 |
| `release/installation/service.cjs` | 安装/更新/修复/回退/恢复的唯一状态转换入口，统一锁、候选健康验证和提交 |
| `release/installation/transaction.cjs` | 启动入口与安装指针的前后快照、持久事务记录、恢复及自定义入口保护 |
| `release/installation/files.cjs` | 文件所有权边界、路径/链接/清单验证、限并发复制、原子写入、版本顺序 |
| `release/installation/windows.cjs` | Windows PATH 快照与并发修改检查、安装锁、文件占用句柄、限时进程查询 |
| `release/installation/retention.cjs` | 启动屏障、版本使用保护、旧版本保留/清理及卸载 |
| `release/installation/diagnostics.cjs` | 脱敏分段耗时与失败阶段记录；观察记录失败不改变安装事务结果 |
| `src/app/installation-command.ts` | CLI 维护命令适配，识别托管安装后调用同一管理器；不加载模型或用户凭据 |
| `release/launch-support.ps1`、`emergence.ps1`、`run-manager.ps1` | 参数转义、启动时恢复、版本使用句柄、管理器运行时校验与输出转发 |
| `native/model-config/VersionLease.cs` | 原生模型配置进程全生命周期持有版本使用句柄 |
| `emergence/release/health.cjs` | 用候选自带运行时和一次性独立配置目录验证 CLI、原生终端依赖、Harness 工具就绪及模型配置依赖；无模型请求 |
| 原生 `Program.cs --installation-check` | 不显示窗口，不连接模型配置服务，只验证 Windows Forms 运行依赖 |
| `emergence/scripts/release-pack.ts` | 将管理器与健康检查一起打包，并将所有发行文件纳入清单和输入指纹 |

引导脚本需要作为单个文件供一行命令执行，下载/缓存/归档验证以具名函数分开，不能在安装前再执行未经校验的远端辅助脚本。点加载只加载函数，供故障注入测试使用；正常执行和一行安装调用同一个安装入口。

## 状态与资源

- 下载缓存独立于安装和用户配置，位于 `%LOCALAPPDATA%/EmergenceCache/downloads`。所有权标记为 `owner.json`；`download.lock` 的排他文件句柄覆盖本次引导操作。
- 完整包和部分包以预期 SHA-256 命名，分别使用 `.zip` 和 `.part`。复用前再次校验；没有可信哈希的小响应不续传。Range 被忽略时覆盖下载，不把完整响应追加到旧片段。
- 启动操作时清理超过 7 天或保留总量超过 1 GiB 的旧下载；当前下载最多 1 GiB，所以下载期间缓存可短时接近 2 GiB。仅删除摘要命名的普通文件，不递归清理任意目录。
- 引导日志只保存最近 20 份，记录阶段、耗时、大小和异常类型；不记录环境变量、凭据、响应正文或 URL。离线管理器在已确认所有权的安装根目录保存 `install-diagnostics.json`。
- 逐文件验证与复制共用至多 8 个工作项。失败时等已有 IO 收尾再删除 stage，避免后台复制与清理竞态。部署仅复制清单声明文件及清单本身；不会悄悄带入源目录的额外文件。
- 安装前检查候选实际启动。健康探测使用系统和程序自带工具，不依赖用户全局 Node、模型密钥或 Python；超时终止探测进程树并等待退出。临时 home 不使用真实用户配置。
- 只检查即将接触的安装路径和本次版本；不在每次升级都遍历所有旧版内容。卸载继续检查整个目标树，拒绝链接与运行中实例。
- 重复安装同一完整发行物不覆盖 `current.previous.json`。同版本损坏或内容不同必须部署新物理目录；逻辑版本号与 `directory` 分离，原目录不被就地覆盖。

## 第二阶段事务与保留规则

`installation.json` 是安装所有权及入口哈希来源；`current.json` 是当前产品唯一指针，`current.previous.json` 是通过检查的回退对象。两者的 `manager` 指向管理引擎，产品回退不要求把安装器也降到旧协议。

`install-transaction.json` 持久记录 `preparing → prepared → activating → activated → committed`。入口、安装标记、版本指针和 PATH 在提交前均可按快照恢复。未提交的中断在下次新版启动器启动时恢复；已提交但未收尾的中断保留新版本。恢复拒绝覆盖不符合事务快照的外部编辑。入口本身损坏、首次安装尚未生成入口、或旧启动器尚未完成迁移时，使用完整发行包重跑安装。

所有维护命令共用安装锁。`.launch.lock` 防止新版入口在切换/清理中读到不完整状态；`.usage/<directory>.lock` 的系统文件句柄保护 CLI 和原生配置进程。PID 与创建时间只作诊断，不能凭一个 PID 判断是否可删除。Windows 进程查询作为额外检查；查询失败或占用不明均推迟清理，不杀用户进程。

`.versions/<directory>.json` 绑定安装 ID、清单哈希和启动协议。清理保留当前/上一可用版本及其管理器，只有未占用、所有权匹配且无链接/额外文件的协议 2 目录可删除。没有使用句柄协议的旧发行物保留，避免旧启动器与清理发生竞态。旧版本记录自身残留不赋予删除权限。

配置、DPAPI 密钥、会话和项目目录不参加事务快照与程序回退。回退检查 `configSchema`，不兼容即拒绝。`-NoPath` 安装偏好持久保留，后续 CLI 维护不会偷偷改真实 PATH；PATH 回滚保留原始注册表类型，不覆盖并发修改。

原有根 `manage.cjs` 实现已退出，新启动桥接只运行受管版本中的统一引擎。旧根文件仅在旧安装迁移时可能遗留，不再作为运行入口。不要为在线更新另写一套复制、回退或清理实现；第三阶段只负责发现/获取发行物，再交给本服务。

## 维护和验收入口

在 `emergence/` 中执行：

```text
npm run check
npm test
npm run test:installation
npm run build
npm run release:prepare
npm run release:pack -- --directory-only
npm run test:release
npm run test:installation:bootstrap
npm run test:installation:maintenance
npm run test:installation:migration -- "完整的已发布1.0.1发行目录"
```

`test:installation` 用真实本地 HTTP 故障覆盖重试、续传、超时、损坏数据和路径安全，另在隔离注册表键验证 PATH 操作。`test:installation:bootstrap` 只在测试包装层将下载地址映射到本地发行物，实际引导、解压、离线安装和启动检查保持不变；不修改真实 PATH 和用户安装。

事务测试覆盖故障注入、子进程崩溃、磁盘不足、入口冲突和回退格式兼容；真实 maintenance 验收同时保留 CLI 和原生 `--attach` 后台进程，不打开桌面窗口。migration 验收只读指定旧发行目录，在隔离目标完成迁移、中断恢复和回退。维护测试不使用真实模型 API，也不升级用户安装。

`npm run benchmark:installation` 比较旧复制方式和新方式，每种两次并校验全部结果。默认产物在 `artifacts/installation-benchmark`，会产生四份完整副本；需要约 3 GiB 空间，只有确认绝对路径、内容无链接且测试结束后才可清理这些副本。不得对工作区或安装目录使用模糊匹配递归删除。

修改发行布局时必须同步更新 `validateFiles` 的必要文件、`release-pack` 的复制清单/输入指纹，以及真实安装验收。不要为减包体直接删上游依赖：Code 域运行时使用 TypeScript，上游 profile 和扩展存在动态包解析。

1.02 根引导默认读取 `releases/stable.json` 签名稳定通道；指定 `-Version` 仍选择固定发行物。后续发布仍须先上传并验证资产，再切换稳定通道。历史候选见[第四阶段报告](../installation-phase4-report-2026-11-17.md)，正式包及发布核验见[发行记录](../release-audit-1.0.2-2026-11-17.md)。清理同时验证逻辑路径与真实路径在安装根目录内，允许 Windows 8.3 短路径，祖先和子树的链接检查仍然生效。
