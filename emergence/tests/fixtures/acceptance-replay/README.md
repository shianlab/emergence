# R1 离线证据样本

这些文件来自 2026-11-14 的 matrix-9 隔离测试，保留原 task/run/session/call ID、参数、回执哈希和关联关系。不是模型生成的假成功记录。`sourceHash` 是原始 live-team.json 的 SHA256；`capturedAt` 是离线采集时间。

| 文件 | 重放内容 |
| --- | --- |
| deepseek-cross-2.json | 跨目录正确验证；局部合同继承全局验收项 |
| deepseek-cross-1.json | 后续检查成功，但历史工具错误仍使验收阻塞 |
| glm-coding-cross-2.json | 两个会话的未决审批；错误的绝对项目路径 |
| glm-coding-same-2.json | 模型断流，未派出任务；原 coordination 停在 received |
| upstream-error.json | 另一真实样本的 HTTP 500 诊断摘录 |

四个快照只收录验收需要的任务、协调记录、原生工具/审批事件、宿主执行台账、诊断与测试文件哈希；排除助手思考内容和完整会话消息。不含模型配置、凭据或个人项目文件。原始 Windows 测试路径是证据内容，测试不会执行其中的命令、读取这些旧路径或要求这些临时目录继续存在。

在 emergence 目录运行：

```powershell
& node_modules/node/bin/node.exe --import tsx --test tests/acceptance-replay.test.ts
```

需要重新采集某个旧样本时（必须保留其隔离 home、原生日志、SQLite 台账和项目文件）：

```powershell
& node_modules/node/bin/node.exe --import tsx tests/replay-acceptance.ts <旧的live-team.json路径> <新的输出目录>
```

输出目录必须不存在，且在原样本目录之外；不会覆盖原矩阵或上次重评。采集读取当前测试文件的字节，不把它伪称为原运行结束瞬间的快照。缺失历史证据会失败，不用模型总结或审批记录代替执行事实。

边界：这是一套已知 notes.txt / verify.cjs 测试协议的验收工具。局部合同中的“两个目录/每目录”以及 Shell 中引用测试文件的路径仅用于定位这批样本；不是生产语义分析、通用 Shell 解析或授权策略。证据信任根是本机宿主日志与执行台账，不是能够抵抗所有本机文件同时被篡改的数字签名。
