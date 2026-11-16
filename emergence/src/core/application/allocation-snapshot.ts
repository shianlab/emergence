import { digest } from '../storage/execution-journal.ts';
import type { PlanningEnvironment } from './planning-service.ts';

/** Ephemeral v1 observation: never an execution authorization or a persisted task binding. */
export function allocationRevision(environment: PlanningEnvironment) {
  return digest({
    version: 1,
    mode: environment.mode,
    current: environment.currentWindow,
    coordinating: environment.coordinating,
    windows: environment.windows
      .map(({ id, controller: c, profile, dispatchable }) => ({
        id,
        session: c.id,
        project: c.cwd,
        model: c.launch.modelId,
        permissions: [c.permissionSnapshot(), ...c.permissionConstraints(c.agent)],
        modelConfig: c.executionModel(c.agent),
        roles: c.launch.appConfig.orchestration.roles,
        tools: c.ctx.tools
          .definitions(c.agent)
          .map((tool) => tool.name)
          .sort(),
        profile,
        dispatchable,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
