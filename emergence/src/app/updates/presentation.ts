import type { UpdateService, UpdateSnapshot } from './service.ts';

export function updateHint(snapshot?: UpdateSnapshot) {
  if (!snapshot) return '';
  if (snapshot.status === 'installing' || snapshot.status === 'ready') return snapshot.message;
  return snapshot.enabled &&
    snapshot.status === 'available' &&
    snapshot.dismissed !== snapshot.release?.version
    ? snapshot.message
    : '';
}
export function updateChoices(service?: UpdateService) {
  const snapshot = service?.snapshot;
  return [
    { command: '检查更新', description: snapshot?.message ?? '当前运行方式不支持更新', value: 'check' },
    { command: '查看更新说明', description: snapshot?.release?.version ?? '尚无发行信息', value: 'notes' },
    {
      command: '立即更新',
      description:
        snapshot?.status === 'available'
          ? `${snapshot.release!.version} · 当前任务继续运行，下次启动生效`
          : '请先检查可用版本',
      value: 'install:' + (snapshot?.release?.version ?? ''),
    },
    { command: '稍后提醒', description: '本版本不再自动提醒，可随时手动检查', value: 'later' },
    {
      command: snapshot?.enabled ? '关闭自动检查' : '开启自动检查',
      description: '手动检查仍可用',
      value: snapshot?.enabled ? 'off' : 'on',
    },
  ];
}
export async function updateAction(service: UpdateService | undefined, action: string) {
  if (!service) throw Error('当前运行方式未连接更新服务');
  if (action === 'notes') return service.snapshot.release?.notes ?? '尚无经过验证的更新说明';
  if (action === 'check') await service.check(true);
  else if (action === 'later') await service.preference(undefined, true);
  else if (action === 'on' || action === 'off') await service.preference(action === 'on');
  else if (action.startsWith('install:')) await service.install(action.slice(8));
  else throw Error('未知更新操作');
  return service.snapshot.message;
}
