import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Read-only inventory of application code. This records debt; it does not waive it.
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(
  process.env.EMERGENCE_AUDIT_DIR ?? join(app, '../artifacts/iteration-20261108-phase1'),
);
const slash = (value: string) => value.replaceAll('\\', '/');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
const sources = (await files(join(app, 'src'))).filter((path) => /\.(ts|tsx|py)$/.test(path));
const nodes: Array<{ path: string; bytes: number; lines: number; sha256: string }> = [];
const edges: Array<{ from: string; to: string; line: number; typeOnly: boolean; kind: string }> = [];
const declarations: Array<{ path: string; line: number; name: string; kind: string }> = [];
for (const path of sources) {
  const bytes = await readFile(path),
    text = bytes.toString('utf8'),
    local = slash(relative(app, path));
  nodes.push({ path: local, bytes: bytes.length, lines: text.split('\n').length, sha256: hash(bytes) });
  if (!/\.tsx?$/.test(path)) continue;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  function edge(node: ts.Node, specifier: ts.Expression | undefined, typeOnly: boolean, kind: string) {
    if (!specifier || !ts.isStringLiteral(specifier)) return;
    const value = specifier.text;
    edges.push({
      from: local,
      to: value.startsWith('.') ? slash(relative(app, resolve(dirname(path), value))) : value,
      line: line(node),
      typeOnly,
      kind,
    });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause,
        bindings = clause?.namedBindings;
      const onlyTypes =
        !!clause?.isTypeOnly ||
        !!(
          clause &&
          !clause.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((part) => part.isTypeOnly)
        );
      edge(node, node.moduleSpecifier, onlyTypes, 'import');
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const onlyTypes =
        node.isTypeOnly ||
        !!(
          clause &&
          ts.isNamedExports(clause) &&
          clause.elements.length &&
          clause.elements.every((part) => part.isTypeOnly)
        );
      edge(node, node.moduleSpecifier, onlyTypes, 'export');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      edge(node, node.arguments[0], false, 'dynamic-import');
    }
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name
    ) {
      declarations.push({
        path: local,
        line: line(node),
        name: node.name.text,
        kind: ts.SyntaxKind[node.kind],
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const reverse = edges.filter((edge) => edge.from.startsWith('src/core/') && edge.to.startsWith('src/app/'));
const inputs = [];
for (const area of ['src', 'native', 'scripts', 'tests', 'bin', 'assets', 'vendor']) {
  for (const path of await files(join(app, area))) {
    if (/[/\\](__pycache__|node_modules)[/\\]|\.pyc$/.test(path)) continue;
    inputs.push({ path: slash(relative(app, path)), sha256: hash(await readFile(path)) });
  }
}
for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', '.prettierrc.json'])
  inputs.push({ path, sha256: hash(await readFile(join(app, path))) });
const sourceFingerprint = hash(JSON.stringify(nodes.map(({ path, sha256 }) => ({ path, sha256 }))));
const inputFingerprint = hash(JSON.stringify(inputs));
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'architecture.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceFingerprint,
      inputFingerprint,
      scope:
        'Static literal imports; dynamic computed imports and runtime event wiring require manual review.',
      nodes,
      edges,
      reverse,
      declarations,
      inputs,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    sources: nodes.length,
    lines: nodes.reduce((sum, node) => sum + node.lines, 0),
    imports: edges.length,
    reverse: reverse.length,
    reverseRuntime: reverse.filter((edge) => !edge.typeOnly).length,
    sourceFingerprint,
    inputFingerprint,
  }),
);
