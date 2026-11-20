import { z } from 'zod';
import { definitionSchema, type AnalysisDefinition } from './definitions.ts';

const cell = z.string().nullable();
const messages = z.array(z.string());
const count = z.number().int().nonnegative();
const runtime = z.object({
  python: z.string(),
  duckdb: z.string(),
  openpyxl: z.string(),
  scipy: z.string(),
  numpy: z.string(),
});
const query = z.object({
  columns: messages,
  rows: z.array(z.array(cell)),
  sql: z.string(),
  externalAccess: z.literal(false),
});
const analysis = z.object({
  method: definitionSchema.shape.method,
  methodVersion: z.literal(1),
  table: z.array(z.record(z.string(), z.json())),
  summary: z.record(z.string(), z.json()),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean() }).catchall(z.json())),
  warnings: messages,
  inputRows: count,
});
const sheetSelection = z.object({
  selectSheet: z.literal(true),
  sheets: messages,
  warnings: messages,
  runtime,
});
const profile = z.object({
  selectSheet: z.never().optional(),
  sqlTable: z.literal('data'),
  sqlExample: z.string(),
  format: z.enum(['.csv', '.tsv', '.xlsx', '.parquet']),
  rows: count,
  scan: z.literal('full-within-budget'),
  columns: z.array(
    z.object({
      name: z.string(),
      typeHint: z.enum(['identifier-like-text', 'iso-date-text', 'numeric-text', 'text']),
      validIsoDates: count,
      dateRange: z.tuple([z.string(), z.string()]).nullable(),
      storageType: z.literal('text'),
      missing: count,
      blankText: count,
      distinct: count,
      candidateKey: z.boolean(),
    }),
  ),
  duplicateRows: count,
  sample: z.array(z.array(cell)),
  sheets: messages,
  formulaCount: count,
  missingFormulaCaches: count,
  warnings: messages,
  query: query.optional(),
  analysis: analysis.optional(),
  runtime,
});
const workerResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.union([sheetSelection, profile]) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type DataProfile = z.infer<typeof profile>;
export type DataResult = DataProfile | z.infer<typeof sheetSelection>;

export function readWorkerResponse(output: string) {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error('数据执行未返回有效 JSON', { cause: error });
  }
  const parsed = workerResponse.safeParse(value);
  if (!parsed.success) throw new Error('数据执行回执格式不符');
  // Keep the original key order and values for result hashes and report columns.
  return value as z.infer<typeof workerResponse>;
}

export function dataPreview(
  result: DataResult,
  source: { artifact: string; sourceHash: string },
  definition: AnalysisDefinition | null,
  artifacts: { name: string; hash: string }[],
) {
  const provenance = { ...source, remote: '未配置远程数据源；没有使用模拟数据替代' };
  const overBudget = (value: object) => Buffer.byteLength(JSON.stringify(value)) > 24000;
  if (result.selectSheet) {
    const selection = { ...result, ...provenance };
    if (overBudget(selection)) throw new Error('工作表清单超过预算');
    return selection;
  }
  const { selectSheet: _selection, analysis, ...profileResult } = result;
  const preview: Omit<DataProfile, 'selectSheet' | 'query' | 'analysis'> &
    typeof provenance & {
      query?: DataProfile['query'] & { previewOmitted?: boolean };
      analysis?: NonNullable<DataProfile['analysis']> & { totalRows: number; previewOmitted: boolean };
      previewOmitted?: boolean;
      definition?: AnalysisDefinition | null;
      artifacts?: typeof artifacts;
      exitCode?: 0;
    } = {
    ...profileResult,
    ...provenance,
    ...(analysis
      ? {
          exitCode: 0,
          analysis: {
            ...analysis,
            table: analysis.table.slice(0, 20),
            totalRows: analysis.table.length,
            previewOmitted: analysis.table.length > 20,
          },
          definition,
          artifacts,
        }
      : {}),
  };
  if (!overBudget(preview)) return preview;
  preview.sample = [];
  if (preview.query) preview.query = { ...preview.query, rows: [], previewOmitted: true };
  preview.previewOmitted = true;
  if (overBudget(preview)) throw new Error('画像摘要超过预算，请缩小数据列范围');
  return preview;
}
