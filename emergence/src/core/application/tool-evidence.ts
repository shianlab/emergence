import { resolve } from 'node:path';
import { canonicalPermissionPath } from '../adapters/permissions.ts';
import type { EvidenceReceipt } from '../domain/assurance.ts';
import { runManifestSchema, type ResourceVersion } from '../domain/run-manifest.ts';
import { toolArguments, toolContract, toolOutcome, toolPath } from '../domain/tool-contract.ts';
import { digest } from '../storage/execution-journal.ts';
import { fileFingerprint, fileObservation, resourceFingerprint } from './execution-evidence.ts';
import { nativeReadEvidence, observeNativeRead } from './native-read-evidence.ts';

interface EvidenceCall {
  callId: string;
  name: string;
  arguments: unknown;
  cwd: string;
  taskId: string;
  runId?: string;
  sessionId: string;
  modelId?: string;
  signal: AbortSignal;
  verification?: EvidenceReceipt['verification'];
  verificationInputs?: ResourceVersion[];
  invalidInput?: boolean;
}
interface ObservedResult {
  value?: unknown;
  isError?: boolean;
  error?: { info?: { code?: string } };
}

function resource(path: string, observation: Awaited<ReturnType<typeof fileObservation>>): ResourceVersion {
  return {
    path,
    hash: observation.hash,
    state:
      observation.hash === 'missing'
        ? 'missing'
        : observation.hash.startsWith('unknown:')
          ? 'unknown'
          : 'present',
    ...(observation.fileSize === undefined ? {} : { bytes: observation.fileSize }),
  };
}

/** Wrap the real execution. Result-provided manifests/receipts are never trusted. */
export async function captureToolEvidence<T extends ObservedResult>(
  call: EvidenceCall,
  execute: () => Promise<T>,
  record: (receipt: EvidenceReceipt) => Promise<void>,
): Promise<T> {
  const contract = toolContract(call.name, call.arguments);
  if (contract.evidence === 'none') return execute();
  const startedAt = new Date().toISOString(),
    args = toolArguments(call.arguments);
  const pathArgument = toolPath(args);
  const path =
    contract.resource === 'file' && pathArgument !== undefined ? resolve(call.cwd, pathArgument) : undefined;
  const before = path && contract.operation === 'read' ? await fileObservation(path) : undefined;
  const inputs = path && before && contract.operation === 'read' ? [resource(path, before)] : [];
  const queryRoot =
    contract.resource === 'project'
      ? resolve(call.cwd)
      : contract.resource === 'query-root'
        ? resolve(call.cwd, pathArgument ?? '.')
        : undefined;
  const argumentsHash = digest(args);
  const code =
    contract.operation === 'command' && typeof args.command === 'string' ? args.command : undefined;
  let executionInputs: ResourceVersion[] = [];
  let executionOutputs: ResourceVersion[] = [];
  let invalidObservation = false;

  const finish = async (result: ObservedResult) => {
    const after = path ? await fileObservation(path) : undefined;
    const nativeInputs = executionInputs.length ? executionInputs : nativeReadEvidence(result.value);
    const sources = [...(call.verificationInputs ?? []), ...(nativeInputs.length ? nativeInputs : inputs)];
    const observedInputs = [...new Map(sources.map((r) => [r.path, r])).values()];
    if (
      observedInputs.length > 32 ||
      sources.some((r) => observedInputs.some((v) => v.path === r.path && v.hash !== r.hash))
    )
      throw new Error('验证输入覆盖超过预算或版本冲突，不能截断证据');
    const inputValid =
      (contract.evidence !== 'file' ||
        (!!before && !!after && inputs[0]?.state === 'present' && before.hash === after.hash)) &&
      (
        await Promise.all(
          observedInputs.map(async (input) => input.hash === (await resourceFingerprint(input))),
        )
      ).every(Boolean);
    const outputValid =
      (contract.operation !== 'write' ||
        (!!after && after.hash !== 'missing' && !after.hash.startsWith('unknown:'))) &&
      (
        await Promise.all(
          executionOutputs.map(
            async (o) => o.state === 'present' && o.hash === (await fileFingerprint(o.path)),
          ),
        )
      ).every(Boolean);
    invalidObservation = !inputValid || !outputValid;
    let status = toolOutcome(call.name, result.value, !!result.isError, call.signal.aborted);
    if (status === 'succeeded' && (!inputValid || !outputValid)) status = 'failed';
    const value = toolArguments(result.value),
      command = contract.evidence === 'command';
    const resultHash = digest(result);
    const manifest = runManifestSchema.parse({
      schemaVersion: 1,
      taskId: call.taskId,
      runId: call.runId,
      sessionId: call.sessionId,
      callId: call.callId,
      tool: call.name,
      contract: {
        version: contract.version,
        authority: contract.authority,
        input: contract.input,
        output: contract.output,
      },
      argumentsHash,
      ...(code === undefined ? {} : { codeHash: digest(code) }),
      resultHash,
      inputs: observedInputs,
      outputs: executionOutputs.length
        ? executionOutputs
        : path && after && contract.operation === 'write'
          ? [resource(path, after)]
          : [],
      resourceCoverage: path ? 'file' : queryRoot || observedInputs.length ? 'query-snapshot' : 'untracked',
      startedAt,
      endedAt: new Date().toISOString(),
      status,
      environment: { runtime: process.version, platform: process.platform, modelId: call.modelId },
      budget: contract.budget,
      checks: [
        { kind: 'tool-result', passed: status === 'succeeded' },
        ...(contract.evidence === 'file' || observedInputs.length
          ? [{ kind: 'input-version', passed: inputValid }]
          : []),
        ...(contract.operation === 'write' || executionOutputs.length
          ? [{ kind: 'output-version', passed: outputValid }]
          : []),
        ...(command
          ? [{ kind: 'process-exit', passed: value.exitCode === 0 && status === 'succeeded' }]
          : []),
      ],
    });
    const receipt: EvidenceReceipt = {
      id: call.callId,
      tool: call.name,
      kind:
        contract.evidence === 'file' || contract.evidence === 'query'
          ? 'read'
          : command
            ? 'command'
            : 'other',
      ok: status === 'succeeded',
      hash: resultHash,
      argumentsHash,
      manifest,
      ...(call.invalidInput && result.isError && result.error?.info?.code === 'INVALID_ARGS'
        ? { failure: 'invalid-arguments' as const }
        : {}),
      ...(call.verification ? { verification: call.verification } : {}),
      ...(contract.evidence === 'file' && path && after
        ? {
            path,
            fileHash: after.hash,
            fileSize: after.fileSize,
            trailingNewline: after.trailingNewline,
            utf8Bom: after.utf8Bom,
          }
        : {}),
      ...(queryRoot ? { queryRoot } : {}),
      ...(command && typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
    };
    await record(receipt);
  };

  let result: T;
  try {
    const observed = await observeNativeRead(execute);
    result = observed.result;
    executionInputs = observed.resources;
    executionOutputs = observed.outputs;
  } catch (error) {
    // Do not persist exception text: it may contain credentials or raw sensitive rows.
    await finish({ isError: true, value: { executionThrew: true } });
    throw error;
  }
  await finish(result);
  return invalidObservation ? { ...result, isError: true } : result;
}

export async function evidenceIsCurrent(
  receipt: EvidenceReceipt,
  superseded = new Map<string, string>(),
): Promise<boolean> {
  // Only objective closure supplies historical versions, after proving a final dependent writer.
  const fingerprint = (path: string) =>
    superseded.get(canonicalPermissionPath(path, path)) ?? fileFingerprint(path);
  if (
    receipt.path &&
    (receipt.fileHash?.startsWith('unknown:') || receipt.fileHash !== (await fingerprint(receipt.path)))
  )
    return false;
  if (!receipt.manifest) return true; // Legacy checks remain as before; provenance stays absent.
  for (const resource of [...receipt.manifest.inputs, ...receipt.manifest.outputs]) {
    if (
      resource.state === 'unknown' ||
      resource.hash !==
        (resource.kind === 'directory'
          ? await resourceFingerprint(resource)
          : await fingerprint(resource.path))
    )
      return false;
  }
  return true;
}
