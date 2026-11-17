import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TaskRecord } from '../domain/task.ts';

/** Execution consumes checked evidence, never a mutable CodeWorkflow. */
export interface CodeEvidence {
  repairedChecks: ReadonlyArray<readonly [failed: string, succeeded: string]>;
  result?: NonNullable<TaskRecord['result']>['code'];
  unverifiedChanges: boolean;
}

export interface CodeEvidencePort {
  evidence(agent: Agent): Promise<CodeEvidence>;
}
