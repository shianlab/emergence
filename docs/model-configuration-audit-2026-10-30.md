# 模型配置插件全面巡检

日期：2026-10-30。范围：从可视化选择、保存、加密凭据，到窗口分配、Harness 实际推理和重启恢复。个人配置与个人 Key 未被测试数据覆盖。

后续用户已要求全部原生控件；当前交付为 Windows Forms `.exe`，见 [原生工具报告](model-configuration-native-report.md)。下方浏览器测试记录为迁移前证据，后端配置能力沿用并重新回归。

## 结论与验证边界

配置不是界面占位：当前个人配置 `deepseek / deepseek-flash` 已通过真实 `api.deepseek.com` 连接测试（1031 ms），并通过实际涌现 CLI 收到指定模型回复。完整结果见 `artifacts/model-configuration/audit-live.json`。

15 个国内预设都经过保存 → DPAPI 加密 → 从保存值测试连接 → 分配窗口 → 实际 Harness 发请求 → 收到目标模型回复。这里使用隔离本机服务替换域名，保留预设地址路径，严格核对路径、模型 ID 和鉴权；它验证涌现的连接链路，不代表已登录其他厂商账号。未提供 Key 的厂商，其真实账号权限、订阅额度及外网连通性仍需在界面点击“测试连接”验证。

## 已修复问题

| 问题 | 修复与证据 |
| --- | --- |
| Anthropic 填 `/v1` 后，连接测试和 SDK 实际地址可能不一致，运行时重复 `/v1` | 统一地址处理；根地址与旧 `/v1` 输入都只请求 `/v1/messages`，使用实际 Anthropic SDK 与完整 Harness 验证 |
| Google 表单支持的协议不在已安装 Harness 协议集合内 | 统一到 Google 官方 OpenAI 兼容地址；连接测试与实际 Harness 共用同一协议及地址转换 |
| 保存新 Key 后，显式 shell 环境变量仍优先生效，原来缺少说明 | 模型状态标明“环境变量优先”；保存明确提示覆盖关系，单测验证清除变量后读取保存值及后续轮换 |
| 推理模型可能因 32 token 测试预算耗尽而被误判失败 | 有上限地提高到 1024 token，仍遵守模型 maxTokens 和 20 秒超时；只有有效模型回复才算成功 |
| 流式读取 JSON 时，跨 chunk 的中文可能被拆坏 | 累计字节后统一 UTF-8 解码 |
| 新增/编辑时焦点落在折叠连接信息中 | 新增焦点放在厂商选择，编辑焦点放在 Key 输入 |

Google 路线依据：[Google 官方 OpenAI compatibility 文档](https://ai.google.dev/gemini-api/docs/openai)。国内预设的官方来源随各预设保存在 `emergence/src/app/model-presets.ts`。

## 浏览器与持久化实测

使用隔离目录，浏览器内逐个选择全部 15 个国内预设，验证自动填写地址、协议、模型和独立凭据名；更换预设清空上一个输入 Key。

随后在浏览器选择千帆 Coding 测试配置，填入本机严格服务地址和虚拟 Key，点击测试、保存、分配到窗口 2。独立进程读取 `config.json`，确认保存字段一致；解密后 Key 一致，配置文件与凭据文件均无 Key 明文。测试工作台再从窗口 2 发出真实 Harness 请求，实际模型为 `qianfan-code-latest`，得到成功回复。

错误虚拟 Key 返回 HTTP 401；清空输入后测试成功，证明确实读取了保存的加密 Key。没有将这些测试配置写入个人 `.emergence`。

证据位于 `artifacts/model-configuration`：

- `audit-ui-presets.json`：15 个预设的实际表单值。
- `audit-ui-storage.json`：独立读盘与 DPAPI 解密结果，不含 Key 值。
- `audit-ui-runtime.json`：从界面分配后的实际窗口、会话、模型与回复结果。
- `audit-ui.jpg`：520 像素宽的白底小窗及连接成功提示；无水平溢出。
- 浏览器 warn/error 为空。

此处截图验证网页在小窗尺寸的布局；Windows 独立窗口启动和按内容调整尺寸使用专用浏览器 profile，原生窗口尺寸本轮未重新截图认证。

## 自动化与防护覆盖

| 检查 | 结果 |
| --- | --- |
| `npm test` | 145 / 145 通过，0 跳过；包含 10 项模型配置专项测试 |
| `npm run inspect:model-config` | 18 / 18 路线通过：15 个国内预设及 Anthropic、Responses、Google；实际 Harness、HTTP/SSE、鉴权校验 |
| 重启恢复 | 无 Key 环境变量的新 CLI 进程读取已轮换的 DPAPI Key，请求鉴权成功 |
| 会话与窗口 | 切换模型保留会话和历史；默认分配、主/副/后台窗口、忙碌拒绝通过 |
| `npm run test:tui-home` | 首页配置入口不创建 Agent 或布局，通过 |
| `npm run test:tui-workspace` | 焦点、角色、详情、草稿、后台状态等回归通过 |
| `npm run test:e2e` | 实际 CLI/plugin、文件工具、PowerShell、Skill、MCP、恢复、OpenAI/Anthropic、缺 Key 与鉴权脱敏通过 |
| `npm run build` | 通过；静态资源随 dist 打包 |
| `npm run typecheck` / 前端 JS 语法检查 | 通过；最终复查时同步编排模块的参数更新已齐全，本轮未修改该编排逻辑 |

模型字段并行编辑冲突、配置原子写入、运行时失败回滚、引用保护、非 JSON/空回复拒绝、HTTP Host/Origin/Bearer 边界均有自动化覆盖。保存模型和保存凭据是两笔事务；若 Key 已保存而后续配置失败，界面明确说明，不显示成功。

普通专项测试完全本地；`npm run test:model-config:live` 会对现有前 4 个模型逐个发送最多两次小请求。本轮只有 DeepSeek 配置了凭据，外网验证范围因此只有 DeepSeek。运行这些测试不会自动创建其他厂商订阅或模型权限。
