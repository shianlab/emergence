import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { safeError } from '../../core/adapters/redaction.ts';
import type { TaskRecord } from '../../core/domain/task.ts';
import { effectiveKeys, keyAction, palette } from '../../core/domain/ui-preferences.ts';
import type { WorkspaceController } from '../workspace.ts';
import { historicalObjective } from '../../core/storage/task-history.ts';
import { fitCells, paneNumber, taskCounts, taskState } from './workspace-chrome.ts';

/** Read-only task presentation. Actions delegate to the existing workspace commands. */
export function mountTaskInspector(
  renderer: CliRenderer,
  workspace: WorkspaceController,
  changed: () => void,
  report: (error: unknown) => void,
) {
  let opened = false,
    focused = false,
    selected: string | undefined,
    fullscreen = false,
    overview = false;
  let listRows = 4,
    lastDetail = '',
    lastTask: string | undefined;
  const box = new BoxRenderable(renderer, {
    position: 'absolute',
    visible: false,
    flexDirection: 'column',
    overflow: 'hidden',
    border: ['left'],
    paddingLeft: 1,
    paddingRight: 1,
    onMouseDown(event) {
      event.stopPropagation();
      if (!focused) {
        focused = true;
        changed();
      }
    },
  });
  const bar = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: 'row' });
  const title = new TextRenderable(renderer, {
    flexGrow: 1,
    height: 1,
    attributes: TextAttributes.BOLD,
    wrapMode: 'none',
    truncate: true,
  });
  const close = new TextRenderable(renderer, {
    width: 6,
    height: 1,
    selectable: false,
    content: '[关闭]',
    onMouseDown(event) {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    },
  });
  bar.add(title);
  bar.add(close);
  box.add(bar);
  const overviewButton = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    selectable: false,
    onMouseDown(event) {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        overview = !overview;
        lastTask = undefined;
        changed();
      }
    },
  });
  box.add(overviewButton);
  const summary = new TextRenderable(renderer, { height: 2, flexShrink: 0, wrapMode: 'word' });
  box.add(summary);
  const list = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0 });
  box.add(list);
  const rows: TextRenderable[] = [];
  const separator = new TextRenderable(renderer, { height: 1, flexShrink: 0 });
  box.add(separator);
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    stickyScroll: false,
  });
  box.add(scroll);
  const detail = new TextRenderable(renderer, { wrapMode: 'word', content: '' });
  scroll.add(detail);
  const owner = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: 'none', truncate: true });
  box.add(owner);
  const jump = new TextRenderable(renderer, {
    height: 1,
    flexShrink: 0,
    selectable: false,
    wrapMode: 'none',
    truncate: true,
    onMouseDown(event) {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        visit();
      }
    },
  });
  box.add(jump);
  const hint = new TextRenderable(renderer, { height: 1, flexShrink: 0, wrapMode: 'none', truncate: true });
  box.add(hint);
  function hide() {
    opened = focused = false;
    changed();
  }
  function task() {
    return workspace.taskEngine.state.tasks.find((item) => item.id === selected);
  }
  function select(id: string) {
    overview = false;
    selected = id;
    lastTask = undefined;
    focused = true;
    changed();
  }
  function visit() {
    const item = task();
    if (overview || !item) return;
    const pane = workspace.panes.get(item.target);
    if (!pane || pane.controller?.id !== item.targetSession) {
      report('任务执行会话已结束或被替换；请查看保留的任务结果与日志');
      return;
    }
    opened = focused = false;
    void workspace.send(workspace.focused, '/task focus ' + item.id).catch(report);
    changed();
  }
  function detailSections(item: TaskRecord, en: boolean) {
    const field = (zh: string, english: string, value: string | undefined) => ({
      title: en ? english : zh,
      body: value || '—',
    });
    const texts = [
      { title: taskState(item, en) + '  ' + item.id, body: '' },
      field('目标', 'Objective', item.objective),
      field('最新回执', 'Latest receipt', item.progress),
      field('计时与处理', 'Timing and next action', workspace.taskEngine.diagnose(item)),
      field(
        '归属',
        'Ownership',
        `${en ? 'Issuer' : '发起会话'} ${paneNumber(workspace, item.issuer) || '—'} · ${item.issuer}\n${en ? 'Execution session' : '执行会话'} ${paneNumber(workspace, item.target) || '—'} · ${item.target}`,
      ),
    ];
    if (item.result?.errors.length) texts.push(field('失败回执', 'Errors', item.result.errors.join('\n')));
    if (item.assessment)
      texts.push(
        field(
          '独立审查 / 验证',
          'Independent assessment',
          `${item.assessment.kind} · ${item.assessment.subject}\n${item.assessment.checks ? '已提交逐项回执；当前有效性请 /audit show 核对' : '等待实际证据'}\n${JSON.stringify(item.assessment.checks ?? [])}`,
        ),
      );
    if (item.contract && !item.assessment)
      texts.push(
        field(
          '证据检查',
          'Evidence checks',
          `/audit show ${item.id} · /audit history ${item.id}\n用户验收：${item.review?.actor === 'user' ? (item.review.accepted ? '已接受（不等于独立验证）' : '未接受') : '尚未记录'}`,
        ),
      );
    if (item.review)
      texts.push(
        field(
          item.review.accepted ? '验收通过 · 证据' : '验收未通过 · 证据',
          item.review.accepted ? 'Accepted · evidence' : 'Rejected · evidence',
          item.review.evidence,
        ),
      );
    if (item.contract)
      texts.push(
        field(
          '验收标准',
          'Acceptance criteria',
          item.contract.acceptance.map((text, i) => `${i + 1}. ${text}`).join('\n'),
        ),
      );
    if (item.result) {
      texts.push(field('执行结果', 'Execution result', item.result.summary));
      if (item.result.artifacts.length)
        texts.push(field('交付物', 'Artifacts', item.result.artifacts.join('\n')));
    }
    if (item.report)
      texts.push(
        field(
          '执行者自报（以实际回执和验收为准）',
          'Worker report (receipts and review remain authoritative)',
          item.report.summary,
        ),
      );
    texts.push(field('项目 / 模型配置', 'Project / model config', item.cwd + '\n' + item.modelId));
    if (item.contract)
      texts.push(
        field(
          '范围 / 交付物',
          'Scope / deliverables',
          [...item.contract.scope, ...item.contract.deliverables].join('\n'),
        ),
        field(
          '预算',
          'Budget',
          `${en ? 'Steps' : '模型步数'} ${item.steps}/${item.contract.maxSteps} · ${en ? 'Repair' : '修复'} ${item.repairCount}/${item.contract.maxRepairs}`,
        ),
      );
    if (item.dependsOn.length) texts.push(field('依赖', 'Dependencies', item.dependsOn.join('\n')));
    const historical = historicalObjective(workspace.taskEngine.state, item);
    if (historical) texts.push(field('历史总目标（只读）', 'Historical objective (read only)', historical));
    if (item.allocation) texts.push(field('分配原因', 'Allocation reason', item.allocation.reason));
    texts.push(
      field(
        '会话日志',
        'Session log',
        `${en ? 'Issuer' : '发起会话'} ${item.issuerSession}\n${en ? 'Execution session' : '执行会话'} ${item.targetSession}${item.result ? `\nseq ${item.result.fromSeq}–${item.result.toSeq}` : ''}`,
      ),
    );
    if (item.repairOf) texts.push(field('修复来源', 'Repair of', item.repairOf));
    if (item.cancelReason) texts.push(field('取消原因', 'Cancellation reason', item.cancelReason));
    texts.push(field('创建 / 更新', 'Created / updated', item.createdAt + '\n' + item.updatedAt));
    return texts.map((section) => ({ title: safeError(section.title), body: safeError(section.body) }));
  }
  return {
    box,
    scroll,
    detail,
    overviewButton,
    jump,
    get opened() {
      return opened;
    },
    get focused() {
      return focused;
    },
    get fullscreen() {
      return fullscreen;
    },
    get selected() {
      return selected;
    },
    get canVisit() {
      const item = task();
      return Boolean(
        !overview && item && workspace.panes.get(item.target)?.controller?.id === item.targetSession,
      );
    },
    open(id?: string) {
      if (id && !workspace.taskEngine.state.tasks.some((item) => item.id === id))
        throw new Error('任务不存在');
      overview = false;
      selected = id ?? selected;
      opened = focused = true;
      changed();
    },
    openOverview() {
      overview = true;
      lastTask = undefined;
      opened = focused = true;
      changed();
    },
    close: hide,
    releaseFocus() {
      if (focused && !fullscreen) {
        focused = false;
        changed();
      }
    },
    sync(width: number, height: number) {
      const ui = workspace.launch.appConfig.ui,
        en = ui.language === 'en',
        colors = palette(ui);
      box.visible = opened;
      fullscreen = width < 118;
      if (!opened) return { width: 0, fullscreen: false };
      const panelWidth = fullscreen ? width : Math.max(38, Math.min(54, Math.floor(width * 0.33)));
      box.left = fullscreen ? 0 : width - panelWidth;
      box.top = 0;
      box.width = panelWidth;
      box.height = height;
      box.border = fullscreen ? ['top'] : ['left'];
      box.borderColor = focused ? colors.accent : colors.border;
      box.backgroundColor = colors.background;
      title.content = `${en ? 'Tasks' : '任务'} · ${workspace.taskEngine.state.tasks.length}`;
      title.fg = colors.accent;
      close.content = en ? '[Close]' : '[关闭]';
      close.width = en ? 7 : 6;
      close.fg = colors.muted;
      summary.fg = colors.muted;
      summary.content = taskCounts(workspace.taskEngine.state.tasks, en);
      overviewButton.fg = colors.accent;
      overviewButton.content = overview ? '[返回子任务列表]' : '[查看总目标与分工]';
      const tasks = [...workspace.taskEngine.state.tasks].reverse();
      if (!selected || !tasks.some((item) => item.id === selected)) selected = tasks[0]?.id;
      const index = Math.max(
        0,
        tasks.findIndex((item) => item.id === selected),
      );
      listRows = overview ? 0 : Math.max(1, Math.min(5, Math.floor((height - 4) / 6)));
      const start = Math.max(0, Math.min(index - Math.floor(listRows / 2), tasks.length - listRows));
      while (rows.length < listRows) {
        const row = new TextRenderable(renderer, {
          height: 2,
          flexShrink: 0,
          selectable: false,
          wrapMode: 'none',
          truncate: true,
        });
        rows.push(row);
        list.add(row);
      }
      rows.forEach((row, i) => {
        const item = tasks[start + i];
        row.visible = i < listRows && Boolean(item);
        if (!item) return;
        const active = item.id === selected;
        row.fg = active ? colors.accent : colors.muted;
        row.bg = active ? colors.input : colors.background;
        row.attributes = active ? TextAttributes.BOLD : 0;
        row.content =
          fitCells(`${active ? '›' : ' '} ${taskState(item, en)} · ${item.id}`, panelWidth - 4) +
          '\n  ' +
          fitCells(item.objective, panelWidth - 6);
        row.onMouseDown = (event) => {
          if (event.button === 0) {
            event.preventDefault();
            event.stopPropagation();
            select(item.id);
          }
        };
      });
      separator.content = '─'.repeat(Math.max(1, panelWidth - 4));
      separator.fg = colors.border;
      const item = task(),
        sections = overview
          ? [
              {
                title: en ? 'Independent session tasks' : '独立会话任务',
                body: taskCounts(workspace.taskEngine.state.tasks, en),
              },
            ]
          : item
            ? detailSections(item, en)
            : [
                {
                  title: en ? 'No tasks' : '暂无任务',
                  body: en
                    ? 'Assignments and their actual receipts appear here.'
                    : '派发任务后，这里显示任务与真实回执。',
                },
              ];
      const next = JSON.stringify([sections, colors.accent, colors.foreground]);
      detail.fg = colors.foreground;
      if (next !== lastDetail) {
        detail.content = new StyledText(
          sections.flatMap((section, index) => [
            fg(colors.accent)(bold((index ? '\n\n' : '') + section.title)),
            fg(colors.foreground)(section.body ? '\n' + section.body : ''),
          ]),
        );
        lastDetail = next;
      }
      if (lastTask !== selected) {
        scroll.scrollTop = 0;
        lastTask = selected;
      }
      const bound = item && workspace.panes.get(item.target)?.controller?.id === item.targetSession;
      owner.visible = jump.visible = !overview;
      owner.fg = colors.muted;
      owner.content = item
        ? `${en ? 'Worker' : '执行窗口'} ${paneNumber(workspace, item.target) || '—'} · ${bound ? (en ? 'session matches' : '原会话') : en ? 'session replaced / closed' : '原会话已更换或关闭'}`
        : '';
      jump.content =
        item && bound ? (en ? '[Go to worker]' : '[进入执行窗口]') : en ? 'History retained' : '历史结果保留';
      jump.fg = item && bound ? colors.accent : colors.muted;
      const keys = effectiveKeys(ui),
        short = (key: string) => key.replaceAll('PageUp', 'PgUp').replaceAll('PageDown', 'PgDn');
      hint.fg = colors.muted;
      hint.content = focused
        ? en
          ? `↑↓ tasks · ${short(keys.pageUp)}/${short(keys.pageDown)} details · Esc back`
          : `↑↓ 任务 · ${short(keys.pageUp)}/${short(keys.pageDown)} 详情 · Esc 返回`
        : en
          ? `Click to inspect · ${keys.tasks} select task`
          : `点击查看 · ${keys.tasks} 选择任务`;
      return { width: panelWidth, fullscreen };
    },
    handleKey(key: KeyEvent) {
      if (!opened || (!focused && !fullscreen)) return false;
      const consume = () => {
        key.preventDefault();
        key.stopPropagation();
        return true;
      };
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        hide();
        return consume();
      }
      if (key.ctrl && ['p', 'r'].includes(key.name)) return false;
      const action = keyAction(workspace.launch.appConfig.ui, key);
      if (action === 'tasks') return false;
      if (key.name === 'up' || key.name === 'down') {
        const tasks = [...workspace.taskEngine.state.tasks].reverse(),
          index = Math.max(
            0,
            tasks.findIndex((item) => item.id === selected),
          );
        if (tasks.length)
          select(tasks[(index + (key.name === 'up' ? tasks.length - 1 : 1)) % tasks.length].id);
        return consume();
      }
      if (action === 'pageUp' || action === 'pageDown') {
        scroll.scrollBy(action === 'pageUp' ? -8 : 8);
        return consume();
      }
      if (key.name === 'right' || key.name === 'return') {
        if (key.eventType !== 'repeat' && !key.repeated) visit();
        return consume();
      }
      // Inspection keys never become a hidden chat submission or approval response.
      return consume();
    },
  };
}
