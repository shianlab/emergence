import type { CodeWorkflow } from '../domains/code/workflow.ts';

export function formatCodeStatus(status: Awaited<ReturnType<CodeWorkflow['status']>>) {
  const states: Record<string, string> = {
    passed: '通过',
    'failed-or-stale': '失败或版本已过期',
    'not-run': '未运行',
  };
  return [
    `编程检查 · ${status.verified ? '当前检查通过' : '尚未完成验证'}`,
    `项目：${status.root}`,
    `任务记录：${status.runId ?? '尚未开始'}`,
    '',
    '检查与实际回执',
    ...(status.checks.length
      ? status.checks.map((check) =>
          [
            `[${states[check.state]}] ${check.command}`,
            `  项目内目录：${check.directory}`,
            ...(check.latest
              ? [
                  `  最近退出码：${check.latest.exitCode ?? '未返回'}；${check.latest.invocation ? `实际目录：${check.latest.invocation.cwd}` : '旧记录未提供执行目录'}`,
                  ...check.latest.diagnostics.map((item) => `  ${JSON.stringify(item)}`),
                  ...(check.latest.output ? [`  输出摘要：\n${check.latest.output}`] : []),
                ]
              : []),
          ].join('\n'),
        )
      : ['未发现可识别的检查命令；请明确项目的测试方式，当前不能声称验证通过。']),
    '',
    '本轮文件变更',
    ...(status.changes.length
      ? status.changes.map(
          (change) =>
            `${change.path} · ${change.uncertain ? '结果待核对' : change.current ? '与记录一致' : '文件已继续变化，请先核对'}`,
        )
      : ['暂无本轮变更记录']),
    ...status.warnings,
    '',
    status.next,
    status.coverage,
    '/code preview "文件路径" 可查看恢复预览；实际恢复仍经过原有工具权限与文件版本核对。',
  ].join('\n');
}

export function formatCodePreview(preview: Awaited<ReturnType<CodeWorkflow['preview']>>) {
  return [
    `恢复预览：${preview.path}`,
    preview.restorable
      ? '可申请恢复；尚未写入文件。'
      : '当前不可自动恢复；请核对新增文件、并发修改或不确定的变更。',
    `变更起始行 ${preview.diff.fromLine}；原内容 ${preview.diff.removedLines} 行，当前内容 ${preview.diff.addedLines} 行`,
    '原内容：',
    preview.diff.removed || '（空）',
    '当前内容：',
    preview.diff.added || '（空）',
    ...(preview.truncated ? ['预览已截短，请读取完整文件后核对。'] : []),
    preview.note,
  ].join('\n');
}
