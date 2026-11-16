import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResourceVersion } from '../domain/run-manifest.ts';

/** In-process provenance channel. Never deserialize this from tool payloads or model input. */
const observations = new WeakMap<object, readonly ResourceVersion[]>();
const execution = new AsyncLocalStorage<{ resources: ResourceVersion[]; outputs: ResourceVersion[] }>();
const inheritedInputs = new AsyncLocalStorage<ResourceVersion[]>();
/** Host check adapters bind small, complete source snapshots before ordinary shell dispatch.
 * Larger snapshots stay in the Code artifact; never present a sliced list as complete. */
export function withNativeCheckInputs<T>(resources: ResourceVersion[], run: () => Promise<T>): Promise<T> {
  const safe = resources.length <= 32 ? resources.map((resource) => Object.freeze({ ...resource })) : [];
  const active = execution.getStore();
  if (active) active.resources = safe;
  return inheritedInputs.run(safe, run);
}
export function attachNativeReadEvidence<T extends object>(value: T, resources: ResourceVersion[]): T {
  const safe = resources.slice(0, 32).map((resource) => Object.freeze({ ...resource }));
  observations.set(value, safe);
  const active = execution.getStore();
  if (active) active.resources = safe;
  return value;
}
/** Output schema normalization may clone JSON values. Keep provenance across that
 * boundary without placing a forgeable field in the model-visible result. */
export async function observeNativeRead<T>(run: () => Promise<T>) {
  const scope = { resources: [...(inheritedInputs.getStore() ?? [])], outputs: [] as ResourceVersion[] };
  return execution.run(scope, async () => ({
    result: await run(),
    resources: scope.resources,
    outputs: scope.outputs,
  }));
}
export function nativeReadEvidence(value: unknown): ResourceVersion[] {
  return value !== null && typeof value === 'object' ? [...(observations.get(value) ?? [])] : [];
}

export function attachNativeOutputs(resources: ResourceVersion[]) {
  if (resources.length > 32) throw new Error('Native output evidence budget exceeded');
  const active = execution.getStore();
  if (active) active.outputs = resources.map((r) => Object.freeze({ ...r }));
}
