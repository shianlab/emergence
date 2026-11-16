# 参考源码与依赖

DeepSeek Harness：DeepSeek AI，MIT；运行依赖由 `emergence/package-lock.json` 锁定的 npm 包提供。原始研究压缩包及未被引用的解压副本已于 2026-10-30 清理，下载哈希见 `docs/research/upstream-downloads.json`；完整 LICENSE 与上游 notices 保留在 `emergence/vendor/upstream-notices/`。

dsh-TUI：Copyright (c) 2026, chimney (ccch1mneyyy)，MIT；重复压缩包已清理，参考源码仍位于 `references/dsh-TUI-main/`，用于阶段一 esbuild 渲染器对照测试。保留参考工程原 LICENSE，并在 `emergence/vendor/upstream-notices/` 保留副本；未将其品牌或完整 UI 作为涌现产品。

OpenTUI：anomalyco，MIT，使用 npm 发布的 `@opentui/core@0.7.0`；原生组件的第三方许可随依赖提供。其他依赖及其具体版本见 `emergence/package-lock.json`，许可随各自依赖保留。

阶段一未向外发布。后续打包任何复用源码时，随发行物保留对应完整许可与著作权说明。
