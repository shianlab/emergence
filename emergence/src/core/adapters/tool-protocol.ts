import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

/** Project the supported Harness schema subset; Zod remains the authoritative validator. */
export function schemaParameter(schema: z.ZodType): ValueSchemaSpec {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
  function project(node: Record<string, any>): ValueSchemaSpec {
    const description = [
      node.description,
      ...['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems']
        .filter((k) => node[k] !== undefined)
        .map((k) => `${k}: ${node[k]}`),
    ]
      .filter(Boolean)
      .join('; ');
    const annotations = description ? { description } : {};
    switch (node.type) {
      case 'object': {
        const properties: ParameterSchemaSpec = {};
        for (const [name, child] of Object.entries(node.properties ?? {}))
          properties[name] = {
            ...project(child as Record<string, any>),
            ...(node.required?.includes(name) ? { required: true as const } : {}),
          };
        return {
          type: 'object',
          properties,
          additionalProperties: node.additionalProperties !== false,
          ...annotations,
        };
      }
      case 'array':
        return { type: 'array', items: project(node.items), ...annotations };
      case 'string':
        return { type: 'string', ...(node.enum ? { enum: node.enum } : {}), ...annotations };
      case 'integer':
        return { type: 'integer', ...annotations };
      case 'number':
        return { type: 'number', ...annotations };
      case 'boolean':
        return { type: 'boolean', ...annotations };
      default:
        throw new Error(`Unsupported tool schema node: ${node.type ?? 'missing type'}`);
    }
  }
  return project(json);
}
export function schemaParameters(schema: z.ZodType): ParameterSchemaSpec {
  const projected = schemaParameter(schema);
  if (!('type' in projected) || projected.type !== 'object') throw new Error('Expected object tool schema');
  return projected.properties ?? {};
}

/** v0.1 compatibility only: exactly one representation, never merge conflicting plans. */
export function protocolInput(args: Record<string, unknown>, field: string, legacy: string): unknown {
  const keys = Object.keys(args);
  if (
    keys.some((key) => key !== field && key !== legacy) ||
    (args[field] !== undefined) === (args[legacy] !== undefined)
  ) {
    throw protocolError('INPUT_CONFLICT', '只提交一个输入字段', [
      {
        path: field,
        code: 'exclusive_input',
        message: `使用 ${field} 对象；兼容字段 ${legacy} 不得同时提供。`,
      },
    ]);
  }
  return args[field] ?? args[legacy];
}
export function protocolError(
  code: string,
  message: string,
  issues: Array<{ path: string; code: string; message: string }> = [],
) {
  return new Error(
    JSON.stringify({
      code,
      message,
      issues,
      suggestion: '修正所列字段并保留原始目标、约束及验收标准；不要修改授权或虚构证据。',
    }),
  );
}
export function parseProtocol<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw protocolError('INVALID_JSON', '兼容输入不是有效 JSON');
    }
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw protocolError(
      'INVALID_ARGUMENTS',
      '参数未通过领域校验',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    );
  return result.data;
}
