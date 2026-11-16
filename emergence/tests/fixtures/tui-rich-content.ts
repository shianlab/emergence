export const richReply = `# 已完成首轮检查

这里有 **加粗重点**、*补充说明* 和 \`src/app.ts\`。

## 调整内容

1. 保留完整历史
2. 让消息更容易阅读
   - 中文和 emoji 🙂 都可以显示
   - 超长条目换行后应当保持列表缩进

> 提醒：待确认操作仍属于原来的会话。

\`\`\`ts
const literal = "**literal_code**";
console.log("# not a heading", literal);
\`\`\`

| 名称 | 状态 |
| --- | --- |
| 首页 | 已完成 |
| 消息排版 | 已接入 |

[查看文档](https://example.com/docs)

PHASE2_RICH_COMPLETE`;
