import { canonicalPermissionPath } from '../adapters/permissions.ts';
import type { Contract } from '../domain/orchestration.ts';
import type { TaskRecord } from '../domain/task.ts';
import type { EvidenceReceipt, Assessment } from '../domain/assurance.ts';
import type { ResourceVersion } from '../domain/run-manifest.ts';
import { toolArguments } from '../domain/tool-contract.ts';
import { stableDigest } from '../storage/execution-journal.ts';
import { fileObservation } from './execution-evidence.ts';
import { scopedPath } from './project-contract.ts';

async function observe(path: string, canRead: (path: string) => boolean): Promise<ResourceVersion> {
  if (!canRead(path)) throw new Error('验证输入读取权限不足：' + path);
  const file = await fileObservation(path);
  if (!/^[a-f0-9]{64}$/.test(file.hash)) throw new Error('验证输入不是可完整观察的普通文件：' + path);
  return { path, hash: file.hash, state: 'present', bytes: file.fileSize };
}
/** Admission captures immutable test/config baselines; model-supplied hashes are never accepted. */
export async function freezeVerification(
  contract: Contract,
  canRead: (path: string) => boolean,
): Promise<Contract> {
  if (!contract.binding) return contract;
  const verifications = [];
  for (const spec of contract.binding.verifications) {
    const baseline = [];
    for (const path of spec.configuration) {
      const observed = await observe(path, canRead);
      baseline.push({ path: observed.path, hash: observed.hash });
    }
    verifications.push({ ...spec, baseline });
  }
  return { ...contract, binding: { ...contract.binding, verifications } };
}
/** Called inside normal tools/execute, after the existing approval gate, immediately before dispatch. */
export async function prepareVerification(
  task: TaskRecord,
  name: string,
  input: unknown,
  canRead: (path: string) => boolean,
) {
  const binding = task.contract?.binding;
  if (!binding || !['pwsh', 'bash'].includes(name)) return;
  const args = toolArguments(input);
  const cwd = canonicalPermissionPath(
    typeof args.workdir === 'string' ? args.workdir : typeof args.cwd === 'string' ? args.cwd : task.cwd,
    task.cwd,
  );
  const spec = binding.verifications.find(
    (v) => v.tool === name && v.command === args.command && v.cwd === cwd,
  );
  if (!spec) return;
  if (spec.projectId !== binding.project.id || spec.configuration.length !== spec.baseline.length)
    throw new Error('验证规格缺少宿主项目或脚本基线');
  const inputs = [];
  for (const path of [...new Set([...spec.inputs, ...spec.configuration])]) {
    if (scopedPath(binding.project.root, path) !== path) throw new Error('验证输入真实路径已变化');
    inputs.push(await observe(path, canRead));
  }
  for (const base of spec.baseline)
    if (
      !spec.configuration.includes(base.path) ||
      inputs.find((i) => i.path === base.path)?.hash !== base.hash
    )
      throw new Error('验证脚本或配置已改变，不能使用旧规格：' + base.path);
  return { inputs, identity: { id: spec.id, projectId: spec.projectId, cwd, specHash: stableDigest(spec) } };
}

/** Describe the same exact-match relation used by admission; candidates are revalidated on submission. */
export function verificationRequirements(contract: Contract | undefined, receipts: EvidenceReceipt[]) {
  return (contract?.binding?.verifications ?? []).map((spec) => ({
    id: spec.id,
    criteria: spec.criteria,
    tool: spec.tool,
    command: spec.command,
    cwd: spec.cwd,
    receipts: receipts
      .filter(
        (r) =>
          r.ok &&
          r.exitCode === 0 &&
          r.verification?.id === spec.id &&
          r.verification.specHash === stableDigest(spec) &&
          r.verification.projectId === spec.projectId &&
          r.verification.cwd === spec.cwd &&
          [...spec.inputs, ...spec.configuration].every((p) =>
            r.manifest?.inputs.some((i) => i.path === p && i.state === 'present'),
          ),
      )
      .map((r) => r.id),
  }));
}

/** A local criterion can only cite its own current, host-bound verification specification. */
export function verificationGaps(
  contract: Contract | undefined,
  checks: NonNullable<Assessment['checks']>,
  receipts: EvidenceReceipt[],
) {
  const gaps: Array<{ criterion: number; specification: string; candidates: string[] }> = [];
  for (const spec of verificationRequirements(contract, receipts))
    for (const criterion of spec.criteria) {
      const check = checks.find((c) => c.criterion === criterion);
      if (!check?.passed) continue;
      if (!check.receipts.some((id) => spec.receipts.includes(id)))
        gaps.push({ criterion, specification: spec.id, candidates: spec.receipts.slice(-4) });
    }
  return gaps;
}
export function verificationCovered(
  contract: Contract | undefined,
  checks: NonNullable<Assessment['checks']>,
  receipts: EvidenceReceipt[],
) {
  return verificationGaps(contract, checks, receipts).length === 0;
}
