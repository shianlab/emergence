# 参与开发

使用 Windows x64、Node 26.13.0 和 `npm ci`。修改前阅读 `AGENTS.md` 与 `emergence/EMERGENCE.md`。以根目录 README 的当前产品范围为准，历史阶段记录不是待重新启用的需求。

## 代码边界

- `core/domain` 放纯规则与数据契约，不访问文件、环境或 Harness。
- `core/application` 经端口协调流程；`core/adapters` 对接 Harness，`core/storage` 负责持久化。
- `app` 组装会话、配置、窗口与 TUI；`domains/code`、`domains/data` 实现业务工具。
- 任务状态只经 `TaskLifecycle` 更新；拒绝、取消、重试与恢复应保留证据，不能以模型成功总结替代实际回执。
- 保持窗口独立。历史编排测试宿主只在 `tests/fixtures` 内使用，不向产品引入恢复跨窗口控制的开关。

## 提交前检查

在 `emergence/` 执行 `npm run check`、`npm test` 和受改动影响的专项验收。`npm run format` 统一自有 TypeScript 排版。涉及 TUI、审批或执行链路时运行 `npm run inspect:full`；涉及凭据和依赖时补充 `npm run inspect:security`。

新增回归应复现用户行为或安全边界，避免只复述实现。保持测试输入与输出在临时目录或被忽略的 `artifacts/` 下；不要提交真实会话、模型密钥、私有项目内容或开发者路径。测试失败须保留原因，不通过增加无条件重试掩盖问题。

`npm test` 中部分历史图测试验证共享任务引擎、恢复与证据契约，不表示产品仍提供协作功能。`historical:*` 是旧阶段辅助脚本，不属于发布检查。

PR 说明问题、最终行为、验证和限制；修改第三方派生资产时保留来源、许可证和变更说明。上传前按 [SECURITY.md](SECURITY.md) 检查待提交内容与历史。

## Windows 发行维护

版本同步修改 `package.json`、锁文件根版本和 `src/app/version.ts`。发布名称 1.00 对应 SemVer 1.0.0。当前采用 GitHub Release 分发，不向 npm 自动发布。

依次执行 `npm run build`、`npm run release:prepare`、`npm run release:pack`、`npm run test:release`，再用 Windows PowerShell 运行 `tests/release-bootstrap.ps1`。最后一项模拟 HTTPS 响应，实际执行 ZIP 校验和隔离安装；公网下载需在 Release 发布后额外验证。不要上传未经测试的包、临时配置或开发者环境。

更新根目录 `install.ps1` 的默认版本、CHANGELOG、发布说明和双语 README。Release 上传 ZIP 与同名 `.sha256`，保留 `sbom.json` 和组件许可。不得覆盖已有版本产物；修复发行物需使用新版本。
