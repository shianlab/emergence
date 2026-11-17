import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { analyzeDependencies, dependencyViolation, forbiddenCycles } from '../scripts/architecture-graph.ts';

test('dependency checks detect type-only cycles through imports, re-exports and import types', () => {
  const graph = analyzeDependencies(resolve('.'), [
    { path: 'src/domains/code/a.ts', text: "import type { B } from './b.ts'; export type A = B;" },
    { path: 'src/domains/code/b.ts', text: "export type { C as B } from './c.ts';" },
    { path: 'src/domains/code/c.ts', text: "export type C = import('./a.ts').A;" },
  ]);
  assert.deepEqual(graph.dependencies.valueImportCycles, []);
  assert.equal(forbiddenCycles(graph.dependencies.allImportCycles).length, 1);
  assert.ok(graph.edges.every((edge) => edge.typeOnly));
});

test('value loads, computed imports and directional boundaries remain distinguishable', () => {
  const graph = analyzeDependencies(resolve('.'), [
    { path: 'src/platform/a.ts', text: "export * from './b.ts';" },
    {
      path: 'src/platform/b.ts',
      text: "const a = require('./a.ts'); import('./a.ts'); import(config.module);",
    },
  ]);
  assert.equal(graph.dependencies.valueImportCycles.length, 1);
  assert.equal(graph.computedImports.length, 1);
  assert.equal(graph.computedImports[0].expression, 'config.module');
  for (const [from, to] of [
    ['src/domains/code/host.ts', 'src/app/controller.ts'],
    ['src/core/application/runtime-ports.ts', 'src/domains/code/work-harness.ts'],
    ['src/platform/text-file.ts', 'src/core/storage/plan-store.ts'],
    ['src/domains/code/project.ts', 'src/domains/data/service.ts'],
  ])
    assert.ok(dependencyViolation(from, to));
  assert.equal(dependencyViolation('src/app/controller.ts', 'src/domains/data/harness.ts'), undefined);
  assert.equal(
    dependencyViolation('src/domains/code/harness.ts', 'src/core/adapters/capability-access.ts'),
    undefined,
  );
  assert.equal(dependencyViolation('src/domains/code/project.ts', 'src/platform/text-file.ts'), undefined);
});

test('retired runtime dependencies are forbidden while history decoding remains allowed', () => {
  for (const module of [
    'team-coordinator',
    'team-followthrough',
    'task-coordinator',
    'audit-allocation',
    'planning-drafts',
  ])
    assert.match(
      dependencyViolation('src/app/workspace.ts', `src/core/application/${module}.ts`)!,
      /retired/,
    );
  assert.equal(dependencyViolation('src/app/workspace.ts', 'src/core/storage/task-history.ts'), undefined);
  assert.equal(dependencyViolation('src/app/workspace.ts', 'src/core/application/task-engine.ts'), undefined);
});
