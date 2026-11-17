import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { analyzeDependencies, dependencyViolation, forbiddenCycles } from './architecture-graph.ts';

const root = process.cwd();
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options),
  checker = program.getTypeChecker();
const errors: string[] = [];
const graph = analyzeDependencies(
  root,
  program
    .getSourceFiles()
    .filter((source) => relative(root, source.fileName).replaceAll('\\', '/').startsWith('src/'))
    .map((source) => ({ path: relative(root, source.fileName).replaceAll('\\', '/'), text: source.text })),
);
for (const group of forbiddenCycles(graph.dependencies.allImportCycles))
  errors.push('type/value dependency cycle crosses an enforced boundary: ' + group.join(' -> '));
let checked = 0;
const local = (file: string) => relative(root, file).replaceAll('\\', '/');
const isTask = (node: ts.Node) =>
  ['requestKey', 'issuerSession', 'targetSession', 'status'].every((key) =>
    checker.getTypeAtLocation(node).getProperty(key),
  );
function taskRoot(node: ts.Node): boolean {
  return (
    isTask(node) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && taskRoot(node.expression))
  );
}
for (const source of program.getSourceFiles()) {
  const file = local(source.fileName);
  if (!file.startsWith('src/')) continue;
  checked++;
  const domain = file.startsWith('src/core/domain/');
  const fail = (node: ts.Node, reason: string) =>
    errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${reason}`);
  function dependency(node: ts.Node, specifier: ts.Node | undefined) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return;
    const name = specifier.text,
      target = name.startsWith('.') ? local(resolve(dirname(source.fileName), name)) : name;
    const violation = dependencyViolation(file, target);
    if (violation) fail(node, violation);
    if (
      domain &&
      ((name.startsWith('.') && !target.startsWith('src/core/domain/')) ||
        name.startsWith('node:') ||
        builtinModules.includes(name))
    )
      fail(node, 'domain must remain pure and independent of IO/adapters');
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) dependency(node, node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      dependency(node, node.argument.literal);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')
    )
      dependency(node, node.arguments[0]);
    if (
      domain &&
      ts.isPropertyAccessExpression(node) &&
      ['process', 'globalThis.process'].includes(node.expression.getText(source))
    )
      fail(node, 'domain must receive runtime/environment facts through arguments');
    if (!file.endsWith('/task-lifecycle.ts')) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        taskRoot(node.left)
      )
        fail(node, 'task writes belong to TaskLifecycle');
      if (
        (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        taskRoot(node.operand)
      )
        fail(node, 'task counters belong to TaskLifecycle');
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (
          ['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse'].includes(
            node.expression.name.text,
          ) &&
          taskRoot(node.expression.expression)
        )
          fail(node, 'task collections belong to TaskLifecycle');
        if (
          node.expression.getText(source) === 'Object.assign' &&
          node.arguments[0] &&
          taskRoot(node.arguments[0])
        )
          fail(node, 'task writes belong to TaskLifecycle');
      }
    }
    // A bare Promise is too easy to lose in event handlers. Explicit void means intentional background work.
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      checker.getTypeAtLocation(node.expression).getProperty('then')
    )
      fail(node, 'Promise requires await, return, or explicit void with an error owner');
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const error of errors) console.error(error);
console.log(`${checked} source files checked; ${errors.length} architecture violations`);
if (errors.length) process.exitCode = 1;
