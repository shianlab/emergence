import { effectiveKeys, type UIPreferences } from '../core/domain/ui-preferences.ts';
import type { WorkspaceController } from './workspace.ts';

export interface CommandItem {
  command: string;
  description: string;
  usage?: string;
  shortcut?: string;
}
type Entry = [string, string, string, string?];
const entries: Entry[] = [
  ['/help', '使用帮助：按用途查找操作和例子', 'Help and examples'],
  ['/model', '切换模型：选择当前窗口使用的模型', 'Select model', '[配置 ID]'],
  ['/model-config', '打开可视化模型配置与窗口分配', 'Open model configuration'],
  ['/doctor', '只读诊断：项目、Git、模型凭据与数据环境', 'Read-only runtime diagnostics'],
  [
    '/code',
    '编程检查、变更记录与恢复预览',
    'Code checks and recovery preview',
    '[status|preview "文件路径"]',
  ],
  [
    '/permission',
    '执行权限：选择计划、询问、编辑或自动',
    'Permission mode',
    '[plan|ask|edit|auto|rules|revoke|default <模式>|rule allow/ask/deny <工具> [path/command 范围]|remove <编号>]',
  ],
  ['/new', '开始新会话', 'New session'],
  ['/history', '搜索当前会话输入历史，回填草稿', 'Search input history', '[关键词]'],
  ['/approvals', '所有窗口的待确认请求：选择后进入所属窗口', 'Pending requests across panes'],
  [
    '/approval',
    '按请求身份允许、拒绝或取消',
    'Respond by request identity',
    '<请求 ID> <版本> allow|deny|cancel',
  ],
  ['/task accept', '验收任务', 'Accept task with evidence', '<任务 ID> \"证据\"'],
  ['/task reject', '拒绝验收', 'Reject task', '<任务 ID> \"证据\"'],
  ['/task repair', '创建有限修复', 'Repair task', '<任务 ID> \"反馈\"'],
  ['/task focus', '进入执行窗口', 'Focus task worker', '<任务 ID>'],
  ['/sessions', '历史会话', 'Session history'],
  ['/resume', '恢复历史会话', 'Resume session', '<会话 ID>'],
  ['/view context', '查看或收起后台资料', 'Show or hide background context'],
  ['/view latest', '回到最新消息', 'Back to latest'],
  ['/view raw', '查看回复原文', 'Show raw reply'],
  ['/view render', '排版显示回复', 'Render reply'],
  ['/view tools', '展开工具详情', 'Tool details'],
  ['/view more', '显示更多正文', 'Show more'],
  ['/instructions', '项目指引与来源', 'Project instructions', '[reload|config|path 路径]'],
  ['/init', '预览规则草案', 'Preview project instructions', '[personal|local|apply]'],
  ['/keys', '实际快捷键', 'Keyboard shortcuts'],
  ['/settings', '当前设置', 'Settings'],
  ['/models', '模型配置详情', 'Model details'],
  ['/theme', '主题设置', 'Theme'],
  ['/language', '界面语言', 'Language', 'zh-CN|en'],
  ['/bind', '修改快捷键', 'Bind a shortcut', '<动作> <快捷键>'],
  [
    '/activity',
    '状态提示：颜色与动效设置',
    'Activity color and motion',
    '[color amber|gray / motion reduced|normal]',
  ],
  [
    '/core',
    '内置核心：角色、流程、观察与接入范围',
    'Built-in core status',
    '[status|roles|workflow|coverage|events|instructions|off|observe]',
  ],
  ['/plan', '任务规划：查看方案或提交执行图', 'Inspect or run task plan', '[run]'],
  [
    '/recover',
    '中断恢复：核对事实并确认新尝试',
    'Inspect interrupted execution',
    '[inspect <任务> | retry/keep <任务> "核对说明" | events]',
  ],
  ['/audit', '历史审查与验证证据回放', 'Review, verification and evidence', '[show <任务> | history <任务>]'],
  [
    '/memory',
    '记忆：候选、批准、检索、纠错与遗忘',
    'Memory lifecycle',
    '[list | propose project fact "内容" | approve/show/history/forget <ID>]',
  ],
  ['/statusbar', '设置状态栏', 'Status bar', 'on|off|fields project,model,tasks,context'],
  ['/tools', '可用工具', 'Available tools'],
  ['/capabilities', '能力与加载状态', 'Capabilities'],
  ['/skills', '可用技能', 'Skills', '[名称|add-dir 目录]'],
  ['/skill', '加载技能', 'Load a skill', '<名称>'],
  ['/mcp', 'MCP 服务状态', 'MCP status', '[enable|disable <名称>]'],
  ['/context', '上下文详情', 'Context details', '[note 内容|export 文件]'],
  ['/agents', '当前代理', 'Agents'],
  [
    '/extensions',
    '扩展状态（受信任的本机代码）',
    'Trusted local extensions',
    '[enable|disable <ID>|add <ID> 绝对模块路径]',
  ],
  ['/panel', '打开扩展面板', 'Open extension panel', '<面板 ID>'],
  ['/permissions', '工具策略（兼容入口）', 'Tool policy', '[deny|confirm|allow <tool*>|reset]'],
  ['/split right', '向右分屏', 'Split right'],
  ['/split down', '向下分屏', 'Split down'],
  ['/panes', '会话窗口列表', 'Session panes'],
  ['/focus', '切换会话', 'Focus a pane', '<编号或 ID>'],
  ['/maximize', '最大化或恢复', 'Maximize / restore'],
  ['/hide', '隐藏当前窗口', 'Hide pane'],
  ['/show', '显示后台窗口', 'Show pane', '<编号或 ID>'],
  ['/project', '切换项目目录', 'Change project', '"目录"'],
  ['/worktree', '创建隔离工作树', 'Create worktree', '"新目录"'],
  ['/tasks', '任务状态', 'Tasks'],
  ['/roles', '编排角色', 'Roles'],
  ['/task show', '任务详情', 'Task details', '<任务 ID>'],
  ['/task cancel', '停止任务', 'Cancel task', '<任务 ID>'],
  ['/task note', '补充任务指令', 'Task note', '<任务 ID> "补充"'],
  ['/integrations', '成果整合记录', 'Integrations'],
  ['/integrate', '整合工作树', 'Integrate worktree', '<源窗口>'],
  ['/template', '布局模板', 'Templates'],
  ['/close', '关闭当前窗口', 'Close pane'],
  ['/exit', '退出工作台', 'Exit'],
];

export function normalizeHelp(value: string) {
  return ['help', '帮助', '/帮助'].includes(value.trim().toLowerCase()) ? '/help' : value;
}

export function homeCommands(en: boolean, saved: boolean): CommandItem[] {
  return entries
    .filter(([command]) =>
      ['/help', '/doctor', '/model', '/model-config', '/sessions', '/new', '/exit'].includes(command),
    )
    .map(([command, zh, english, usage]) => ({ command, description: en ? english : zh, usage }))
    .concat(
      saved
        ? [
            {
              command: '/continue',
              description: en ? 'Continue saved workspace' : '继续上次工作台',
              usage: undefined,
            },
          ]
        : [],
    );
}

/** Arguments, paths and multiline drafts stay in the editor, never become a menu selection. */
export function slashSuggestions(value: string, items: readonly CommandItem[]) {
  if (!value.startsWith('/') || /[\r\n]/.test(value)) return false;
  if (/^\/(?:[a-zA-Z]:|[.~/\\])/.test(value)) return false;
  if (value.slice(1).split(/\s/)[0].includes('/')) return false;
  const exact = items.find((item) => value.startsWith(item.command + ' '));
  if (exact) return false;
  return true;
}

export function commandShortcut(command: string, ui: UIPreferences) {
  const keys = effectiveKeys(ui);
  return (
    {
      '/history': 'Ctrl+R',
      '/permission': keys.cyclePermission,
      '/split right': keys.splitRight,
      '/split down': keys.splitDown,
      '/tasks': keys.tasks,
      '/close': keys.close,
      '/hide': keys.hide,
      '/maximize': keys.maximize,
    } as Record<string, string>
  )[command];
}

export function commandHelp(items: readonly CommandItem[], ui: UIPreferences, home = false) {
  const en = ui.language === 'en';
  const groups: [string, string, RegExp][] = [
    ['开始对话', 'Conversations', /^\/(help|new|model|models|sessions|resume|continue|history|exit)$/],
    ['模型与权限', 'Permissions', /^\/(permission|instructions|init)$/],
    [
      '窗口与任务',
      'Workspace and tasks',
      /^\/(team|window-role|split|panes|focus|maximize|hide|show|project|worktree|tasks|roles|mode|dispatch|task|assign|assign-role|takeover|release|integrations|integrate|template|close)( |$)/,
    ],
    [
      '能力与上下文',
      'Capabilities and context',
      /^\/(code|tools|capabilities|skills|skill|mcp|context|agents|extensions)( |$)/,
    ],
    ['显示与故障帮助', 'Display and troubleshooting', /.*/],
  ];
  const remaining = new Set(items);
  const sections = groups.flatMap(([zh, english, pattern]) => {
    const matched = [...remaining].filter((item) => pattern.test(item.command));
    for (const item of matched) remaining.delete(item);
    return matched.length
      ? [
          (en ? english : zh) +
            '\n' +
            matched
              .map((item) => {
                const key = commandShortcut(item.command, ui);
                return `  ${item.command}${item.usage ? ' ' + item.usage : ''}  ${item.description}${key ? ` · ${key}` : ''}`;
              })
              .join('\n'),
        ]
      : [];
  });
  return [
    en ? 'Help · Type / to discover commands' : '涌现使用帮助 · 输入 / 就能查找操作',
    en
      ? '↑↓ select · Tab complete · Enter choose · Esc close\nRequired arguments stay in the editor. Nothing is sent until you submit.'
      : '↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 收起\n需要参数的操作会先留在输入框，补全后再提交。',
    ...sections,
    en
      ? 'Examples\n  /model — choose a model\n  /new — start a conversation'
      : '首次使用\n  1. /model-config：配置供应商、模型与密钥；/model 选择当前模型。\n  2. 确认首页项目目录；可在项目文件夹运行 emergence，或进入会话后用 /project "目录" 切换。\n  3. 输入任务并回车；输入 / 可查找操作，/doctor 可检查环境。\n  /new：开始新会话，原来的会话仍保留。',
    home
      ? en
        ? 'Start a conversation to access project, tools and independent panes.'
        : '进入对话后，可使用项目、工具和独立多窗口命令。'
      : en
        ? 'Example: /project "C:/work/demo"\n/keys shows your actual shortcuts. PgUp/PgDn scroll; Esc returns.'
        : '切换项目例子：/project "C:/work/demo"\n多窗口：/split right 或 /split down 分屏；每个窗口分别输入任务，可使用不同项目和模型。窗口之间不自动派活或相互控制。\n编程：/code 查看检查与变更；数据：直接提交文件路径、分析目标和统计口径。\n/keys 查看实际快捷键；PgUp/PgDn 翻页；Esc 返回。\nCtrl+C：清空草稿或停止任务；空闲时连按两次退出。',
  ].join('\n\n');
}

/** Only implemented commands; extensions come from the live registration table. */
export function workspaceCommands(
  workspace: Pick<
    WorkspaceController,
    'panes' | 'launch' | 'collaboration' | 'visible' | 'ctx' | 'extensions'
  >,
  paneId: string,
): CommandItem[] {
  const pane = workspace.panes.get(paneId),
    controller = pane?.controller,
    en = workspace.launch.appConfig.ui.language === 'en';
  const mutable = !controller?.busy && !workspace.collaboration.current(paneId);
  return entries
    .filter(([command]) => {
      if (!controller)
        return ['/help', '/doctor', '/settings', '/keys', '/panes', '/project', '/close', '/exit'].includes(
          command,
        );
      if (controller.pending)
        return [
          '/help',
          '/keys',
          '/permission',
          '/settings',
          '/panes',
          '/focus',
          '/approvals',
          '/approval',
          '/exit',
        ].includes(command);
      if (!mutable && ['/new', '/resume', '/project', '/worktree', '/integrate'].includes(command))
        return false;
      if (command === '/hide' && workspace.visible().length < 2) return false;
      if (command === '/show' && workspace.visible().length === workspace.panes.size) return false;
      if (command === '/skill' && !workspace.ctx.skills) return false;
      return true;
    })
    .map<CommandItem>(([command, zh, english, usage]) => ({
      command,
      description: en ? english : zh,
      usage,
      shortcut: commandShortcut(command, workspace.launch.appConfig.ui),
    }))
    .concat(
      controller && !controller.pending
        ? workspace.extensions.commandNames().map((command) => ({
            command,
            description: en ? 'Extension command' : '扩展命令',
            usage: undefined,
          }))
        : [],
    )
    .concat(
      pane?.error
        ? [
            {
              command: '/retry',
              description: en ? 'Retry session restore' : '重试恢复会话',
              usage: undefined,
            },
          ]
        : [],
    );
}

export function filterCommands(items: readonly CommandItem[], query: string) {
  const words = query.trim().replace(/^\//, '').toLowerCase().split(/\s+/).filter(Boolean);
  const needle = query.trim().replace(/^\//, '').toLowerCase();
  const rank = (item: CommandItem) => {
    const command = item.command.replace(/^\//, '').toLowerCase();
    return command === needle ? 3 : command.startsWith(needle) ? 2 : 1;
  };
  return items
    .filter((item) =>
      words.every((word) => `${item.command} ${item.description}`.toLowerCase().includes(word)),
    )
    .sort((a, b) => rank(b) - rank(a));
}

/** Standalone sessions advertise only their implemented command set. */
export function sessionCommands(en: boolean): CommandItem[] {
  const supported = new Set([
    '/help',
    '/core',
    '/plan',
    '/capabilities',
    '/instructions',
    '/init',
    '/permission',
    '/new',
    '/sessions',
    '/resume',
    '/model',
    '/tools',
    '/exit',
  ]);
  return entries
    .filter(([name]) => supported.has(name))
    .map(([command, zh, english, usage]) => ({ command, description: en ? english : zh, usage }));
}
