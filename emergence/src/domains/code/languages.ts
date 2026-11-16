import { dirname, relative, resolve } from 'node:path';
import type * as TS from 'typescript';
import { hostExecutable, hostProcess, type ProjectSnapshot, type SourceFile } from './project.ts';

export type CodeHit = {
  path: string;
  line: number;
  column: number;
  name: string;
  kind: 'definition' | 'reference' | 'import' | 'text';
  method: string;
  hash: string;
};
export type LanguageResult = {
  hits: CodeHit[];
  imports: Array<{ path: string; module: string; target?: string }>;
  services: string[];
  warnings: string[];
};
const tokens = (query: string) =>
  [...new Set(query.match(/[\p{L}_][\p{L}\p{N}_-]{1,60}/gu) ?? [])].slice(0, 12);
export function relevant(name: string, query: string) {
  const lower = name.toLowerCase();
  return tokens(query).some((t) => lower.includes(t.toLowerCase()));
}

export async function typescriptLookup(
  snapshot: ProjectSnapshot,
  query: string,
  signal: AbortSignal,
): Promise<LanguageResult> {
  const files = snapshot.files.filter((f) => /\.[cm]?[jt]sx?$/.test(f.path));
  const hits: CodeHit[] = [],
    imports: LanguageResult['imports'] = [],
    warnings: string[] = [];
  if (!files.length) return { hits, imports, warnings, services: [] };
  const ts: typeof TS = await import('typescript');
  signal.throwIfAborted();
  const key = (path: string) => {
    const value = resolve(path).replaceAll('\\', '/');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  const byPath = new Map(snapshot.files.map((f) => [key(f.path), f]));
  const options: TS.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noLib: true,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    jsx: ts.JsxEmit.Preserve,
  };
  const config = snapshot.files.find((f) => f.relative === 'tsconfig.json' || f.relative === 'jsconfig.json');
  if (config) {
    const parsed = ts.parseConfigFileTextToJson(config.path, config.text);
    const value = parsed.config?.compilerOptions;
    // Only inert resolution fields; never load project plugins, extends, or execute config JS.
    if (typeof value?.baseUrl === 'string' && !value.baseUrl.includes('..'))
      options.baseUrl = resolve(snapshot.root, value.baseUrl);
    if (value?.paths && typeof value.paths === 'object')
      options.paths = Object.fromEntries(
        Object.entries(value.paths)
          .filter(
            ([k, v]) =>
              k.length < 200 &&
              Array.isArray(v) &&
              v.every((p) => typeof p === 'string' && p.length < 300 && !p.includes('..')),
          )
          .slice(0, 30),
      ) as Record<string, string[]>;
    if (parsed.error || parsed.config?.extends || parsed.config?.references || value?.plugins)
      warnings.push('TS 配置中的继承、项目引用和插件未加载；只分析已扫描源码和本地路径映射。');
  }
  const host: TS.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => snapshot.root,
    getScriptFileNames: () => files.map((f) => f.path),
    getScriptVersion: (p) => byPath.get(key(p))?.hash ?? '',
    getScriptSnapshot: (p) => {
      const f = byPath.get(key(p));
      return f ? ts.ScriptSnapshot.fromString(f.text) : undefined;
    },
    getDefaultLibFileName: () => '',
    fileExists: (p) => byPath.has(key(p)),
    readFile: (p) => byPath.get(key(p))?.text,
    readDirectory: () => [],
    directoryExists: (p) => [...byPath.keys()].some((k) => k.startsWith(key(p) + '/')),
    useCaseSensitiveFileNames: () => process.platform !== 'win32',
    realpath: (p) => p,
  };
  const service = ts.createLanguageService(host);
  const add = (f: SourceFile, pos: number, name: string, kind: CodeHit['kind'], method: string) => {
    if (hits.length >= 120) return;
    const prefix = f.text.slice(0, pos),
      line = prefix.split('\n').length,
      column = pos - prefix.lastIndexOf('\n');
    hits.push({ path: f.relative, line, column, name: name.slice(0, 100), kind, method, hash: f.hash });
  };
  let semanticQueries = 0;
  try {
    const program = service.getProgram();
    for (const file of files) {
      signal.throwIfAborted();
      const source = program?.getSourceFile(file.path);
      if (!source) continue;
      const visit = (node: TS.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const module = node.moduleSpecifier.text,
            resolved = ts.resolveModuleName(
              module,
              file.path,
              options,
              host as TS.ModuleResolutionHost,
            ).resolvedModule;
          if (imports.length < 300)
            imports.push({
              path: file.relative,
              module,
              target: resolved ? byPath.get(key(resolved.resolvedFileName))?.relative : undefined,
            });
        }
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isVariableDeclaration(node) ||
            ts.isMethodDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          const name = node.name.text;
          if (relevant(name, query)) {
            add(file, node.name.getStart(source), name, 'definition', 'typescript-ast');
            if (semanticQueries++ < 8)
              for (const group of service.findReferences(file.path, node.name.getStart(source)) ?? []) {
                for (const ref of group.references) {
                  const f = byPath.get(key(ref.fileName));
                  if (f && !ref.isDefinition)
                    add(f, ref.textSpan.start, name, 'reference', 'typescript-semantic');
                }
              }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    signal.throwIfAborted();
    if (semanticQueries > 8 || hits.length >= 120 || imports.length >= 300)
      warnings.push('TS 候选定义/引用预算已达到上限；缩小符号或文件范围继续定位。');
    return {
      hits,
      imports,
      warnings,
      services: [
        'TypeScript language service：已实际解析；语义覆盖限于本次有界源码快照，不包含依赖库类型或完整项目诊断',
      ],
    };
  } finally {
    service.dispose();
  }
}

// The host sends source text to ast.parse; project modules are never imported/executed.
const pythonParser = String.raw`import ast,json,sys
payload=json.load(sys.stdin)
out=[]
for f in payload:
    try:
        tree=ast.parse(f['text'],filename=f['path'])
        rows=[]
        for n in ast.walk(tree):
            kind=None; name=None
            if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)): kind='definition'; name=n.name
            elif isinstance(n,ast.Name): kind='reference'; name=n.id
            elif isinstance(n,ast.Attribute): kind='reference'; name=n.attr
            elif isinstance(n,ast.ImportFrom): kind='import'; name='.'*n.level+(n.module or '')
            elif isinstance(n,ast.Import):
                for a in n.names: rows.append({'name':a.name,'kind':'import','line':n.lineno,'column':n.col_offset+1})
            if kind: rows.append({'name':name,'kind':kind,'line':n.lineno,'column':n.col_offset+1})
            if len(rows)>=1500: break
        lines=f['text'].splitlines()
        for r in rows:
            prefix=lines[r['line']-1].encode('utf-8')[:r['column']-1].decode('utf-8','ignore')
            r['column']=len(prefix.encode('utf-16-le'))//2+1
        out.append({'path':f['path'],'rows':rows,'limited':len(rows)>=1500})
    except (SyntaxError,ValueError,RecursionError): out.append({'path':f['path'],'error':'parse-failed'})
json.dump(out,sys.stdout,ensure_ascii=True)
`;

export async function pythonLookup(
  snapshot: ProjectSnapshot,
  query: string,
  signal: AbortSignal,
): Promise<LanguageResult> {
  const files = snapshot.files.filter((f) => f.path.endsWith('.py')).slice(0, 40),
    hits: CodeHit[] = [],
    imports: LanguageResult['imports'] = [],
    warnings: string[] = [];
  if (!files.length) return { hits, imports, warnings, services: [] };
  const python = await hostExecutable(process.platform === 'win32' ? 'python' : 'python3', snapshot.root);
  if (!python) throw new Error('没有可用的宿主 Python');
  const result = JSON.parse(
    await hostProcess(
      python,
      ['-I', '-S', '-B', '-X', 'utf8', '-c', pythonParser],
      dirname(python),
      signal,
      JSON.stringify(files.map((f) => ({ path: f.relative, text: f.text }))),
      2_000_000,
      5000,
    ),
  ) as Array<{
    path: string;
    error?: string;
    limited?: boolean;
    rows?: Array<{ name: string; kind: 'definition' | 'reference' | 'import'; line: number; column: number }>;
  }>;
  for (const item of result) {
    const file = files.find((f) => f.relative === item.path);
    if (!file) continue;
    if (item.error || item.limited)
      warnings.push(`${item.path}：语法错误或 AST 节点预算限制，定位可能不完整。`);
    for (const row of item.rows ?? []) {
      if (row.kind === 'import' && imports.length < 300) {
        const stem = row.name.replace(/^\.+/, '').replaceAll('.', '/');
        const level = row.name.match(/^\.+/)?.[0].length ?? 0;
        const location = level
          ? resolve(
              snapshot.root,
              dirname(file.relative),
              ...Array.from({ length: level - 1 }, () => '..'),
              stem,
            )
          : resolve(snapshot.root, stem);
        const local = relative(snapshot.root, location).replaceAll('\\', '/');
        const target = files.find(
          (f) => f.relative === local + '.py' || f.relative === local + '/__init__.py',
        )?.relative;
        imports.push({ path: file.relative, module: row.name, target });
      }
      if (relevant(row.name, query) && hits.length < 120)
        hits.push({ ...row, path: file.relative, hash: file.hash, method: 'python-ast-name-hint' });
    }
  }
  if (snapshot.files.filter((f) => f.path.endsWith('.py')).length > files.length)
    warnings.push('Python AST 本次最多分析 40 个文件。');
  return {
    hits,
    imports,
    warnings,
    services: ['Python AST：已实际解析；名称引用是语法线索，不是跨模块类型/LSP 语义证明；未执行项目代码'],
  };
}

export async function locate(
  snapshot: ProjectSnapshot,
  query: string,
  signal: AbortSignal,
  disabled = false,
): Promise<LanguageResult> {
  const results: LanguageResult[] = [],
    warnings: string[] = [];
  if (!disabled)
    for (const adapter of [typescriptLookup, pythonLookup]) {
      try {
        results.push(await adapter(snapshot, query, signal));
      } catch {
        signal.throwIfAborted();
        warnings.push(`${adapter === typescriptLookup ? 'TS/JS' : 'Python'} 服务不可用，降级为文本定位。`);
      }
    }
  else warnings.push('语言服务已禁用；只提供文本定位。');
  const hits = results.flatMap((r) => r.hits),
    seen = new Set(hits.map((h) => `${h.path}:${h.line}`));
  for (const file of snapshot.files) {
    signal.throwIfAborted();
    for (const [i, text] of file.text.split('\n').entries()) {
      if (hits.length >= 160) break;
      if (relevant(text, query) && !seen.has(`${file.relative}:${i + 1}`)) {
        hits.push({
          path: file.relative,
          line: i + 1,
          column: 1,
          name: query.slice(0, 100),
          kind: 'text',
          method: 'text-match',
          hash: file.hash,
        });
        seen.add(`${file.relative}:${i + 1}`);
      }
    }
  }
  return {
    hits,
    imports: results.flatMap((r) => r.imports),
    services: results.flatMap((r) => r.services),
    warnings: [...warnings, ...results.flatMap((r) => r.warnings)],
  };
}
