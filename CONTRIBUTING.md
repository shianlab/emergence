# 参与开发

使用 Windows x64、Node 26.13.0 和 `npm ci`。修改前阅读 `AGENTS.md` 与 `emergence/EMERGENCE.md`。以根目录 README 的当前产品范围为准，历史阶段记录不是待重新启用的需求。

结构整理从 [当前维护入口](docs/structure/README.md) 开始，按 [七阶段方案](docs/structure-refactor-plan-2026-11-16.md) 推进；变更前核对职责、状态归属、退役清单与行为验收映射。

## 代码边界

- `core/domain` 放纯规则与数据契约，不访问文件、环境或 Harness。
- `core/application` 经端口协调流程；`core/adapters` 对接 Harness，`core/storage` 负责持久化。
- `app` 组装会话、配置、窗口与 TUI；`domains/code`、`domains/data` 实现业务工具。
- 能力通过最小宿主契约接入，不能反向引用 `app`；核心通过证据契约读取能力结果，不能引用具体 Code/Data 类。`platform` 只保存跨能力基础设施，不依赖业务层。
- 任务状态只经 `TaskLifecycle` 更新；拒绝、取消、重试与恢复应保留证据，不能以模型成功总结替代实际回执。
- 保持窗口独立。共享执行测试直接使用当前 TaskEngine；历史数据用冻结输入验证读取兼容，不构造旧主控宿主或提供恢复跨窗口控制的开关。

## 提交前检查

首次开发按 [编码规范与检查入口](docs/structure/coding-standards.md) 准备固定 SDK，并在 `emergence/` 执行 `npm run setup:quality`。检查工具放在隔离目录，不增加用户运行依赖。

提交前执行 `npm run check`、`npm test` 和受改动影响的专项验收。`npm run format` 统一自有 TypeScript、C#、Python、PowerShell 排版；静态问题另外修复，不把行为调整混进格式提交。涉及 TUI、审批或执行链路时运行 `npm run inspect:full`；涉及凭据和依赖时补充 `npm run inspect:security`。

新增回归应复现用户行为或安全边界，避免只复述实现。保持测试输入与输出在临时目录或被忽略的 `artifacts/` 下；不要提交真实会话、模型密钥、私有项目内容或开发者路径。测试失败须保留原因，不通过增加无条件重试掩盖问题。

`npm test` 验证当前任务引擎、恢复与证据契约，历史数据测试不表示产品仍提供协作功能。已失效的主控/历史命令已退出 package 脚本；旧阶段报告仅供追溯。测试迁移记录见 [第三阶段报告](docs/structure/phase3-report.md)。

PR 说明问题、最终行为、验证和限制；修改第三方派生资产时保留来源、许可证和变更说明。上传前按 [SECURITY.md](SECURITY.md) 检查待提交内容与历史。

## Windows 发行维护

版本同步修改 `package.json`、锁文件根版本和 `src/app/version.ts`。发布名称 1.00 对应 SemVer 1.0.0。当前采用 GitHub Release 分发，不向 npm 自动发布。

依次执行 `npm run build`、`npm run release:prepare`、`npm run release:pack`、`npm run test:release`，再用 Windows PowerShell 运行 `tests/release-bootstrap.ps1`。最后一项模拟 HTTPS 响应，实际执行 ZIP 校验和隔离安装；公网下载需在 Release 发布后额外验证。不要上传未经测试的包、临时配置或开发者环境。

更新根目录 `install.ps1` 的默认版本、CHANGELOG、发布说明和双语 README。Release 上传 ZIP 与同名 `.sha256`，保留 `sbom.json` 和组件许可。不得覆盖已有版本产物；修复发行物需使用新版本。
