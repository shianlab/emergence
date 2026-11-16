import { canonicalPermissionPath } from '../adapters/permissions.ts';
import type { TaskRecord } from '../domain/task.ts';

/** A later writer may supersede an accepted artifact only through declared dependencies. */
export function completionArtifacts(tasks: TaskRecord[], history: TaskRecord[]) {
  const byId = new Map(history.map((task) => [task.id, task]));
  const ancestors = (task: TaskRecord) => {
    const found = new Set<string>();
    const pending = [...task.dependsOn, task.repairOf, task.recoveryOf];
    while (pending.length) {
      const id = pending.pop();
      if (!id || found.has(id)) continue;
      found.add(id);
      const parent = byId.get(id);
      if (parent) pending.push(...parent.dependsOn, parent.repairOf, parent.recoveryOf);
    }
    return found;
  };
  const lineage = new Map(tasks.map((task) => [task.id, ancestors(task)]));
  const origin = (task: TaskRecord) => {
    const seen = new Set<string>();
    while ((task.repairOf || task.recoveryOf) && !seen.has(task.id)) {
      seen.add(task.id);
      const parent = byId.get(task.repairOf ?? task.recoveryOf!);
      if (!parent) break;
      task = parent;
    }
    return task.id;
  };
  const owners = new Map<string, { task: TaskRecord; hash: string }[]>();
  for (const task of tasks)
    for (const artifact of task.artifactVersions) {
      const path = canonicalPermissionPath(artifact.path, task.cwd);
      const entries = owners.get(path) ?? [];
      entries.push({ task, hash: artifact.hash });
      owners.set(path, entries);
    }
  const final = new Map<string, string>();
  const superseded = new Map<string, Map<string, string>>();
  for (const [path, entries] of owners) {
    const last = entries.filter(
      (entry) =>
        !entries.some((other) => other !== entry && lineage.get(other.task.id)!.has(origin(entry.task))),
    );
    // Independent observations of identical bytes agree on the final version.
    // Different terminal versions require an explicit successor; timestamps cannot arbitrate.
    if (!last.length || new Set(last.map((entry) => entry.hash)).size !== 1)
      throw new Error('同一产物存在无依赖关系的多个交付者，无法确认最终版本：' + path);
    final.set(path, last[0].hash);
    for (const entry of entries) {
      if (entry === last[0] || entry.hash === last[0].hash) continue;
      const replaced = superseded.get(entry.task.id) ?? new Map<string, string>();
      replaced.set(path, entry.hash);
      superseded.set(entry.task.id, replaced);
    }
  }
  return { final, superseded };
}
