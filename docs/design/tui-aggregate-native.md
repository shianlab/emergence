# 聚合标记 A 版原生接入

用户于 2026-10-31 确认完整 TUI 预览的默认 A 版，授权接入。

对话页使用 `aggregate-art.ts` 中与已确认 SVG 相同的 Bézier 轮廓和圆点坐标。轮廓预采样、抗锯齿后以 192 × 192 RGBA 交给 OpenTUI 的 `ImageRenderable`；通过实际检测到的 Sixel 或 Kitty 图形协议显示。保留三行顶栏、8 列图形范围和 2 列间距，按终端像素比例等比缩放，不拉伸圆形。

就绪时静止；思考时右上圆点在 2.8 秒周期内轻微上浮和变暗；工具、完成、错误状态沿用预览的圆点颜色。主体不随状态变动。减少动态效果和 NO_COLOR 保持静止；NO_COLOR 还取消圆点状态颜色。亮色主题使用深灰轮廓。切换会话仍按当前会话状态显示。

图形能力或像素尺寸尚未返回时不展示方块近似，检测完成后自动启用图形。不支持终端图形时保留文字品牌。原首页标识、会话编排、输入与消息逻辑不改动。

## 验证

- `npm run typecheck` 和 `npm run build` 通过。
- `tests/tui-aggregate.ts`：圆点中心/角部、分离间隙、主体不动、静止与无色状态、原生图像加载释放、尺寸适配通过。
- `tests/tui-phase4.ts`：工作台 15 项回归通过。
- `tests/tui-phase4-terminal.ts`：真实 ConPTY 终端 9 项回归通过，覆盖任务页、草稿、焦点、退出恢复等。
- `probes/aggregate-native.ts` 在本机 Windows Terminal 1.24.12741.0 实测回执为 Sixel、1200 × 600 像素、120 × 30 字符；192 × 192 原生图像成功加载，无加载错误。回执为 `artifacts/brand/aggregate-native-report.json`。这是图形能力与加载实测，不是截图比对报告。

`aggregate-brand.ts` 只供历史粗像素预览脚本使用，正式工作台已不引用它。浏览器候选预览保留用于对照，不作为原生终端验证证据。
