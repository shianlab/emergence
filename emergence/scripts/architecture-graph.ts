import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
const slash = (value: string) => value.replaceAll('\\', '/');

/** Literal dependency graph shared by inventory and enforcing checks. */
export function analyzeDependencies(app: string, sources: ReadonlyArray<{ path: string; text: string }>) {
  const edges: Array<{ from: string; to: string; line: number; typeOnly: boolean; kind: string }> = [];
  const declarations: Array<{ path: string; line: number; name: string; kind: string }> = [];
  const computedImports: Array<{ path: string; line: number; kind: string; expression: string }> = [];
  const wiring: Array<{ path: string; line: number; call: string; argument: string }> = [];
  for (const { path: local, text } of sources) {
    if (!/\.tsx?$/.test(local)) continue;
    const source = ts.createSourceFile(local, text, ts.ScriptTarget.Latest, true);
    const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    function edge(node: ts.Node, specifier: ts.Expression | undefined, typeOnly: boolean, kind: string) {
      if (!specifier) return;
      if (!ts.isStringLiteralLike(specifier)) {
        computedImports.push({ path: local, line: line(node), kind, expression: specifier.getText(source) });
        return;
      }
      const value = specifier.text;
      edges.push({
        from: local,
        to: value.startsWith('.') ? slash(relative(app, resolve(dirname(join(app, local)), value))) : value,
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
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        edge(node, node.argument.literal, true, 'import-type');
      } else if (ts.isCallExpression(node) && node.expression.getText(source) === 'require') {
        edge(node, node.arguments[0], false, 'require');
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : node.expression.getText(source);
        if (['on', 'once', 'off', 'emit', 'register', 'context', 'setInterval', 'setTimeout'].includes(name))
          wiring.push({
            path: local,
            line: line(node),
            call: node.expression.getText(source),
            argument: node.arguments[0]?.getText(source).slice(0, 160) ?? '',
          });
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
  const paths = new Set(sources.map((node) => node.path));
  for (const edge of edges) {
    if (!edge.to.startsWith('src/')) continue;
    edge.to =
      [edge.to, edge.to + '.ts', edge.to + '.tsx', edge.to + '/index.ts'].find((path) => paths.has(path)) ??
      edge.to;
  }
  // Strongly connected components expose type coupling separately from declared
  // value imports. Computed loads and event subscriptions are not inferred edges.
  function cycles(includeTypes: boolean): string[][] {
    const graph = new Map([...paths].map((path) => [path, new Set<string>()]));
    for (const edge of edges)
      if (paths.has(edge.to) && (includeTypes || !edge.typeOnly)) graph.get(edge.from)!.add(edge.to);
    const indices = new Map<string, number>(),
      low = new Map<string, number>(),
      stack: string[] = [],
      active = new Set<string>(),
      groups: string[][] = [];
    function visit(path: string) {
      indices.set(path, indices.size);
      low.set(path, indices.get(path)!);
      stack.push(path);
      active.add(path);
      for (const target of graph.get(path)!) {
        if (!indices.has(target)) {
          visit(target);
          low.set(path, Math.min(low.get(path)!, low.get(target)!));
        } else if (active.has(target)) low.set(path, Math.min(low.get(path)!, indices.get(target)!));
      }
      if (low.get(path) !== indices.get(path)) return;
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        group.push(member);
      } while (member !== path);
      if (group.length > 1 || graph.get(path)!.has(path)) groups.push(group.sort());
    }
    for (const path of paths) if (!indices.has(path)) visit(path);
    return groups.sort((a, b) => a[0].localeCompare(b[0]));
  }
  const dependencies = {
    valueImportCycles: cycles(false),
    allImportCycles: cycles(true),
    capabilityToApp: edges.filter(
      (edge) => edge.from.startsWith('src/domains/') && edge.to.startsWith('src/app/'),
    ),
    coreToCapabilities: edges.filter(
      (edge) => edge.from.startsWith('src/core/') && edge.to.startsWith('src/domains/'),
    ),
  };

  return { edges, declarations, computedImports, wiring, dependencies };
}

export function dependencyViolation(from: string, to: string): string | undefined {
  if (
    /\/(team-coordinator|team-followthrough|task-coordinator|audit-allocation|work-allocation|coordinator-context|planning-drafts|collaboration-tools|team-bar|team-feedback)\.ts$/.test(
      to,
    )
  )
    return 'retired cross-window runtime must not re-enter production dependencies';
  if (from.startsWith('src/core/') && (to.startsWith('src/app/') || to.startsWith('src/domains/')))
    return 'core depends on contracts, not app or concrete capabilities (including types)';
  if (from.startsWith('src/domains/') && to.startsWith('src/app/'))
    return 'capabilities must not depend on app (including controller types)';
  if (from.startsWith('src/platform/') && to.startsWith('src/') && !to.startsWith('src/platform/'))
    return 'platform must not depend on business or application code';
  if (
    (from.startsWith('src/domains/code/') && to.startsWith('src/domains/data/')) ||
    (from.startsWith('src/domains/data/') && to.startsWith('src/domains/code/'))
  )
    return 'capabilities connect through core contracts, not each other';
}

export function forbiddenCycles(groups: string[][]): string[][] {
  // Internal app/core lifecycle coupling is inventoried for phases 3/4. This
  // phase enforces domain purity, capability independence and layer direction.
  return groups.filter(
    (group) =>
      group.some((file) => /^(src\/core\/domain\/|src\/domains\/|src\/platform\/)/.test(file)) ||
      new Set(group.map((file) => file.split('/')[1])).size > 1,
  );
}
