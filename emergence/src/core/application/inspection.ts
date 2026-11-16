import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { schemaParameters } from '../adapters/tool-protocol.ts';
import {
  canonicalPermissionPath,
  evaluatePermissions,
  permissionFingerprint,
} from '../adapters/permissions.ts';
import type { WorkspacePort } from './runtime-ports.ts';
import { attachNativeReadEvidence } from './native-read-evidence.ts';
import { directoryObservation, fileObservation } from './execution-evidence.ts';

const verificationSchema = z
  .object({
    file_path: z.string().min(1).max(4000),
    checks: z
      .array(
        z
          .object({
            property: z.enum([
              'fileSize',
              'characters',
              'hanCharacters',
              'utf8Valid',
              'utf8Bom',
              'hash',
              'trailingNewline',
            ]),
            operator: z.enum(['equals', 'at-least', 'at-most']),
            expectedNumber: z.number().int().nonnegative().optional(),
            expectedText: z.string().max(128).optional(),
            expectedBoolean: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

/** Both observations and fixed predicates use the original read permission and provenance boundary. */
async function inspect(workspace: WorkspacePort, exec: ToolExecution, file: string) {
  const owner = [...workspace.panes.values()].find((p) => p.controller?.owns(exec.agent))?.controller;
  if (!owner || !exec.agent) throw new Error('文件属性查询缺少所属会话');
  const cwd = workspace.ctx.workingDirectory.get(exec.agent.session);
  const path = canonicalPermissionPath(file, cwd);
  const policies = () => [owner.permissionSnapshot(), ...owner.permissionConstraints(exec.agent)];
  const stamp = permissionFingerprint(policies());
  // The normal executor already approved any ask, including the host read policy alias.
  const allowed = () =>
    !exec.signal.aborted &&
    stamp === permissionFingerprint(policies()) &&
    evaluatePermissions(policies(), {
      name: 'read',
      arguments: { file_path: path },
      cwd,
      actor: exec.agent!.id,
    }).effect !== 'deny';
  if (!allowed()) throw new Error('文件属性查询不绕过 read 的禁止规则或已变化的权限');
  const stat = await lstat(path);
  exec.signal.throwIfAborted();
  if (stat.isDirectory()) {
    const value = await directoryObservation(path);
    if (!allowed()) throw new Error('读取期间权限已变化');
    return attachNativeReadEvidence({ path, kind: 'directory' as const, ...value }, [
      { path, hash: value.hash, state: 'present', kind: 'directory' },
    ]);
  }
  const value = await fileObservation(path, true);
  if (!/^[a-f0-9]{64}$/.test(value.hash) || !allowed()) throw new Error('文件无法完整读取或权限已变化');
  return attachNativeReadEvidence({ path, kind: 'file' as const, ...value }, [
    { path, hash: value.hash, state: 'present', bytes: value.fileSize },
  ]);
}

export function mountInspection(workspace: WorkspacePort) {
  const output = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
  return [
    workspace.ctx.tools.register(
      defineTool({
        name: 'emergence_inspect',
        description:
          '原生只读文件属性/目录清单。返回 SHA256、字节数、UTF-8/BOM、末尾换行、Unicode 码点与汉字数量；目录返回直接成员及清单版本，不运行 Shell、不递归。',
        parameters: { file_path: { type: 'string', required: true } },
        output,
        execute: (args, exec) => inspect(workspace, exec, args.file_path),
      }),
    ),
    workspace.ctx.tools.register(
      defineTool({
        name: 'emergence_verify_file',
        description:
          '原生文件检查：执行字数/字节、编码、哈希、换行的固定断言并生成实际检查回执，不运行命令。checks 每项包含 property/operator；期望值仅填一种：expectedNumber、expectedText 或 expectedBoolean。characters 为 Unicode 码点数，hanCharacters 仅汉字。不能代替明确的代码测试、构建或程序行为验证。',
        parameters: schemaParameters(verificationSchema),
        output,
        execute: async (args, exec) => {
          const input = verificationSchema.parse(args);
          const file = await inspect(workspace, exec, input.file_path);
          if (file.kind !== 'file') throw new Error('原生文件断言只接受普通文件');
          const checks = input.checks.map((check) => {
            const actual = file[check.property];
            const values = [check.expectedNumber, check.expectedText, check.expectedBoolean].filter(
              (value) => value !== undefined,
            );
            if (values.length !== 1) throw new Error('每项断言必须且只能提供一种期望值');
            const expected = values[0];
            if (check.operator !== 'equals' && (typeof actual !== 'number' || typeof expected !== 'number'))
              throw new Error('范围比较仅接受数值属性与数值期望');
            const passed =
              check.operator === 'equals'
                ? actual === expected
                : check.operator === 'at-least'
                  ? (actual as number) >= (expected as number)
                  : (actual as number) <= (expected as number);
            return {
              property: check.property,
              operator: check.operator,
              expected,
              actual: actual ?? null,
              passed,
            };
          });
          return { path: file.path, hash: file.hash, passed: checks.every((c) => c.passed), checks };
        },
      }),
    ),
  ];
}
