import { attachNativeReadEvidence } from '../../core/application/native-read-evidence.ts';
import { locate, type CodeHit } from './languages.ts';
import { codeLimits, projectProfile, scanProject, type ProjectSnapshot } from './project.ts';

export const codeToolNames = [
  'emergence_code_project',
  'emergence_code_locate',
  'emergence_code_context',
] as const;
export type CodeToolName = (typeof codeToolNames)[number];
export type CodeSource = { path: string; hash: string; line: number };
export type CodeResult = {
  schemaVersion: 1;
  root: string;
  version: string;
  query: string;
  tool: CodeToolName;
  sources: CodeSource[];
  hits: CodeHit[];
  snippets: Array<{ path: string; line: number; text: string; reason: string }>;
  relationships: Array<{ path: string; module: string; target?: string }>;
  services: string[];
  warnings: string[];
  truncated: boolean;
  profile?: Awaited<ReturnType<typeof projectProfile>>;
};

export async function codeQuery(
  tool: CodeToolName,
  cwd: string,
  query: string,
  signal: AbortSignal,
  path?: string,
  disableLanguages = false,
  canRead?: (path: string) => boolean,
): Promise<CodeResult> {
  if (query.length > 240 || (!query.trim() && tool !== 'emergence_code_project'))
    throw new Error('代码查询需要 1–240 字的目标或符号名');
  const snapshot = await scanProject(cwd, signal, path, canRead);
  const result: CodeResult = {
    schemaVersion: 1,
    root: snapshot.root,
    version: snapshot.version,
    query,
    tool,
    sources: [],
    hits: [],
    snippets: [],
    relationships: [],
    services: [],
    warnings: [...snapshot.warnings],
    truncated: snapshot.truncated,
  };
  if (tool === 'emergence_code_project') result.profile = await projectProfile(snapshot, signal);
  else {
    const found = await locate(snapshot, query, signal, disableLanguages);
    const rank = (h: CodeHit) =>
      (path && h.path === path.replaceAll('\\', '/') ? -10 : 0) +
      (h.kind === 'definition'
        ? 0
        : h.method === 'typescript-semantic'
          ? 1
          : h.kind === 'reference'
            ? 2
            : h.kind === 'import'
              ? 3
              : 4);
    result.hits = found.hits.sort((a, b) => rank(a) - rank(b)).slice(0, codeLimits.matches);
    result.truncated ||= found.hits.length > result.hits.length || found.warnings.length > 0;
    const selected = new Set(result.hits.slice(0, 12).map((h) => h.path));
    const related = found.imports.filter((i) => selected.has(i.path) || (i.target && selected.has(i.target)));
    result.relationships = related.slice(0, 20);
    result.truncated ||= related.length > 20;
    for (const relation of result.relationships) {
      selected.add(relation.path);
      if (relation.target) selected.add(relation.target);
    }
    result.services = found.services;
    result.warnings.push(...found.warnings);
    if (tool === 'emergence_code_context' && selected.size > 8) result.truncated = true;
    if (tool === 'emergence_code_context')
      for (const name of [...selected].slice(0, 8)) {
        const file = snapshot.files.find((f) => f.relative === name);
        if (!file) continue;
        const hit = result.hits.find((h) => h.path === name),
          start = Math.max(0, (hit?.line ?? 1) - 3);
        result.snippets.push({
          path: name,
          line: start + 1,
          text: file.text
            .split('\n')
            .slice(start, start + 12)
            .map((line, i) => `${start + 1 + i}: ${line}`)
            .join('\n')
            .slice(0, 1300),
          reason: hit ? hit.kind + ' / ' + hit.method : '关联导入或调用方候选；不是运行验证',
        });
      }
  }
  return finalize(result, snapshot, signal);
}

function finalize(result: CodeResult, snapshot: ProjectSnapshot, signal: AbortSignal) {
  const references = () =>
    result.profile
      ? snapshot.files
          .filter((f) => result.profile!.configs.includes(f.relative))
          .slice(0, 24)
          .map((f) => ({ path: f.relative, hash: f.hash, line: 1 }))
      : [
          ...new Set([
            ...result.hits.map((h) => h.path),
            ...result.snippets.map((s) => s.path),
            ...result.relationships.flatMap((r) => [r.path, ...(r.target ? [r.target] : [])]),
          ]),
        ]
          .slice(0, 24)
          .map((path) => ({
            path,
            hash: snapshot.files.find((f) => f.relative === path)!.hash,
            line: result.hits.find((h) => h.path === path)?.line ?? 1,
          }));
  result.sources = references();
  const covered = new Set(result.sources.map((s) => s.path));
  if (
    result.hits.some((h) => !covered.has(h.path)) ||
    result.snippets.some((s) => !covered.has(s.path)) ||
    result.relationships.some((r) => !covered.has(r.path) || (r.target && !covered.has(r.target)))
  )
    result.truncated = true;
  result.hits = result.hits.filter((h) => covered.has(h.path));
  result.snippets = result.snippets.filter((s) => covered.has(s.path));
  result.relationships = result.relationships.filter(
    (r) => covered.has(r.path) && (!r.target || covered.has(r.target)),
  );
  // Keep complete structured items. Never cut JSON or silently claim exhaustive coverage.
  while (Buffer.byteLength(JSON.stringify(result)) > codeLimits.outputBytes) {
    result.truncated = true;
    if (result.snippets.length) result.snippets.pop();
    else if (result.hits.length) result.hits.pop();
    else if (result.relationships.length) result.relationships.pop();
    else if (result.profile?.packages.length) result.profile.packages.pop();
    else if (result.warnings.length) result.warnings.pop();
    else throw new Error('项目元数据超过上下文预算，请缩小工作目录');
    result.sources = references();
  }
  signal.throwIfAborted();
  const resources = result.sources.map((source) => {
    const f = snapshot.files.find((f) => f.relative === source.path)!;
    return { path: f.path, hash: f.hash, bytes: f.bytes, state: 'present' as const };
  });
  // Native tool outputs must be lossless JSON. Optional metadata fields are absent,
  // not undefined; provenance travels separately through the host execution scope.
  const value = JSON.parse(JSON.stringify(result)) as CodeResult;
  return attachNativeReadEvidence(value, resources);
}
