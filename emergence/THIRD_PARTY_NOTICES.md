# 参考源码与依赖

DeepSeek Harness：DeepSeek AI，MIT；实际运行依赖由本工程 `package-lock.json` 锁定的 npm 包提供。原始研究下载及未引用的解压副本已于 2026-10-30 清理；完整 LICENSE 与上游 notices 保留在 `vendor/upstream-notices/`。历史下载哈希见工作区 `docs/research/upstream-downloads.json`。

dsh-TUI：Copyright (c) 2026, chimney (ccch1mneyyy)，MIT；参考源码位于工作区 `references/dsh-TUI-main/`，重复压缩包已清理。阶段一通过 esbuild 对其未经修改的 renderer 源码生成本地对照产物，保留参考工程原 LICENSE，并在 `vendor/upstream-notices/dsh-TUI-LICENSE.txt` 保留副本；未将其品牌或完整 UI 作为涌现产品。

OpenTUI：anomalyco，MIT，使用 npm 发布的 `@opentui/core@0.7.0`；原生组件的第三方许可随依赖提供。其他依赖及其具体版本见 `emergence/package-lock.json`，许可随各自依赖保留。

Marked：Christopher Jeffrey 及贡献者，MIT，使用 npm 发布的 `marked@17.0.1` 解析 Markdown，完整许可随依赖保留。

TypeScript：Microsoft 及贡献者，Apache-2.0，使用已锁定的 `typescript@5.9.3` 提供原生 TS/JS 语言服务。Code 增强第二阶段将已有开发依赖提升为运行依赖；未加载被分析项目的 TypeScript 插件，完整许可随依赖保留。

Meta_Kim 3.7.3：Copyright 2025–2026 KimYx0207，Apache-2.0。本项目的内置治理角色和工作流定义由用户提供的固定版本资料派生；完整许可与原 NOTICE 保存在 `vendor/meta-kim/LICENSE`、`vendor/meta-kim/NOTICE`。来源、变更及保留资料见 `vendor/meta-kim/MODIFICATIONS.md`。并未声称得到原作者背书，亦未安装其宿主 Hooks 或执行上游安装器。

阶段一未向外发布。2026-11-16 起移除已废弃的渲染器对照原型，正式构建、类型检查及产品验收不再依赖 `references/dsh-TUI-main/` 或其生成文件。历史研究来源及原始许可继续保留；分发任何复用源码时随发行物保留对应完整许可与著作权说明。


## 本机数据执行环境（2026-10-31）

独立 `.data-venv` 使用 DuckDB 1.4.3（MIT）、openpyxl 3.1.5（MIT）、et-xmlfile 2.0.0（MIT）。未修改这些库。许可证随安装的 distribution 元数据保留；固定版本清单位于 `src/domains/data/requirements.txt`。当前仅本机调试，后续分发需随产品保留完整上游许可证。

2026-11-16：Windows x64 / CPython 3.14 的五个数据依赖 wheel 已按 PyPI 发布元数据核对 SHA-256，记录在 `runtime-lock.json` 与 `requirements-win32-py314.txt`。wheel 中完整的许可证及捆绑 notices 保存在 `src/domains/data/licenses/`，构建后位于 `dist/data/licenses/`，纳入资源哈希清单和本地候选目录。新版托管环境位于用户配置目录 `runtimes/data/`，不会复制作者的虚拟环境或凭据。

第五阶段增加 SciPy 1.17.0 与 NumPy 2.4.1（均为 BSD-3-Clause 主许可证），用于成熟统计检验与其数值依赖；未修改这些库。完整版权、许可证和 wheel 捆绑第三方 notices 保留在 `.data-venv/Lib/site-packages/scipy-1.17.0.dist-info` 与 `numpy-2.4.1.dist-info` 中。后续发行需一并保留捆绑库 notices，不能只保留主许可证名称。参考 Skill 中的方法流程经独立实现和反例测试吸收，没有执行其安装器或复制演示输出作为分析结果。
