# 第一阶段：版本管理与公开边界

日期：2026-11-08。当前建立的是本地工程基线；不是 GitHub 发布批准，也不是已完成的发行包。

## 文件归属

| 类别 | 当前路径 | 决定 |
| --- | --- | --- |
| 核心源码 | emergence/src、native、bin | 本地 Git 保留，候选公开；不能删除原生配置、Python worker 或内置 KIM |
| 工程与必要测试 | package/lock、tsconfig、scripts、tests、examples、probes | 保留；脚本/测试可能引用本地研究目录，其外部依赖要在说明中明确，不能误称源码包独立跑完所有历史原型 |
| 核心及来源材料 | emergence/vendor/meta-kim、vendor/upstream-notices、THIRD_PARTY_NOTICES | 保留；真正分发时逐项核对许可证和 notice |
| 视觉母版与定稿 | emergence/assets/brand | 保留母版、已确认像素/聚合资产与设计参考；未选设计不自动接入；二进制素材需在公开前继续核对来源与元数据 |
| 工程文档 | README、docs、specs、AGENTS.md | 保留；历史文档明确时点，本轮报告提供当前入口；已去除一处个人下载路径 |
| 研究源码 | references、参考 | 忽略、不删除；dsh-TUI 对照 probes 仍有引用，不当运行依赖打包 |
| 依赖/环境 | node_modules、.data-venv、Python 缓存 | 忽略；依据锁文件和初始化说明重建 |
| 生成物 | dist、acceptance-dist-*、release、根目录原生 exe/config | 忽略、不删除当前可运行文件；Windows exe 由 build-model-config 从源码重建 |
| 原始验收记录 | artifacts 全目录 | 忽略且留在本机；保留审核后的文字摘要和人工合成样本到 docs，不复制原始对话/审批/凭据 |
| 用户配置与运行数据 | .emergence、.meta-kim、credentials、数据库、临时文件、密钥文件 | 忽略；原本位于工程外的用户目录不移动、不纳入版本 |

本地 Git 使用项目根作为仓库边界，不在用户主目录初始化、不设置远程、不上传。保持原始换行，避免基线阶段隐式格式化全项目；格式收口在第二阶段分模块进行。使用已有 Git 作者配置，不更改全局身份。

## 候选审查办法与结果口径

1. 从 `git ls-files --cached --others --exclude-standard -z` 生成候选路径/大小/SHA-256 清单；只读取普通文件，拒绝未审查的符号链接。
2. 对候选文本检测私钥头、常见供应商 token、长字面凭据及个人主目录路径；输出仅含规则、文件、行号，不输出命中内容。
3. 另运行现有 inspect-security，对已保存的凭据做实际明文匹配，执行 npm audit；两种检查互补，不声称能识别所有未知秘密。
4. 当前启发式命中 `tests/model-configuration.test.ts` 的长字符串是人工构造的替换凭据（相邻断言确认），不连接远端服务；保留测试，不因关键字误报而删除安全用例。个人下载路径已在历史说明中脱敏。
5. 原始清单和扫描结果保存在本地 artifacts。人工合成样本见 `fixtures/acceptance-scenarios.json`，没有真实用户提示词、供应商账号或目录。它是未来验收规格，不是已运行报告或生产状态文件。

此检查建立候选边界，不是全面隐私/许可证认证；实际公开前还需复核 Git 历史作者信息、二进制素材元数据、第三方声明、文档链接和发行包清单。未知高熵秘密、外部 MCP 配置与 Python 依赖安全不能由本次文本规则保证。

## 本地证据与复现

所有下列命令在 `emergence` 目录执行。统一使用项目内 Node，避免误用不同版本系统 Node：

```powershell
& './node_modules/node/bin/node.exe' --import tsx scripts/inspect-architecture.ts
& './node_modules/node/bin/node.exe' --import tsx --test tests/*.test.ts
& './node_modules/node/bin/node.exe' './node_modules/typescript/bin/tsc' --noEmit
& './node_modules/node/bin/node.exe' --import tsx scripts/check-orchestration.ts
& './node_modules/node/bin/node.exe' --import tsx scripts/build.ts
```

`inspect-architecture.ts` 输出到 `artifacts/iteration-20261108-phase1/architecture.json`，可用 `EMERGENCE_AUDIT_DIR` 改变输出目录。它记录生产源码哈希、构建输入哈希、静态导入和 23 条已知反向依赖；成功运行代表采集完成，不代表依赖债务已经修复。

构建脚本会生成 dist 并刷新根目录原生工具副本；本阶段未更改其源码或启动 GUI。inspect-security 应通过项目 npm 脚本执行以获得 npm CLI 路径；输出目录同样可配置。它只读凭据进行匹配，不打印或复制明文。

## 许可与发行待办

- 自有代码当前 package license 为 UNLICENSED/private；作者尚未选择公开许可证。
- 保留 DeepSeek Harness、Meta_Kim、OpenTUI 及实际复用资产的来源说明，产品使用 Emergence 名称不改变上游归属。
- 打包需补 Python 运行资源、上游 notice 与可打开的文档；第五/六阶段验证候选包，不能从本地 Git 文件齐全推断 npm 包齐全。
- 不将本机环境、个人凭据或原始验收记录用作发布默认配置。
