import { WorkspaceController } from '../../src/app/workspace.ts';

/** Test-only host for the retained journal/contract engine. Not a product mode or config option.
 * Old security, evidence and recovery fixtures still exercise historical task graphs;
 * shipped workspaces always use session scope, covered by independent-windows.test.ts.
 */
export class HistoricalOrchestrationWorkspace extends WorkspaceController {
  override async setMaster(id: string) {
    if (this.configurationChange) throw new Error('模型配置正在更新，请稍后设置主窗口');
    const team = this.collaboration.state;
    const workers = [...this.panes.values()].filter((p) => p.id !== id && p.controller).map((p) => p.id);
    this.collaboration.assertConfiguration(id, workers);
    const masterModel = this.launch.appConfig.windowModels.master;
    if (team.master !== id && masterModel && this.panes.get(id)?.modelId !== masterModel)
      await this.send(id, `/model ${masterModel}`);
    this.collaboration.configure(id, workers, true);
    this.notice = '已设置主窗口；主控负责理解目标与协调团队，/team 查看能力和角色；执行仍遵循各窗口权限。';
    this.changed();
    await this.save();
  }
  override get executionScope(): 'workspace' {
    return 'workspace';
  }
}
