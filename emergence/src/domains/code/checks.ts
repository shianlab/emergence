import { basename, dirname } from 'node:path';
import type { ProjectSnapshot } from './project.ts';

export type CheckCandidate = {
  id: string;
  kind: string;
  command: string;
  directory: string;
  localCommand: string;
  config: string;
  configHash: string;
};
export type Diagnostic = { path: string; line: number; column: number | null; message: string };
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** Candidates only. Project scripts always execute through the normal approved shell tool. */
export function discoverChecks(snapshot: ProjectSnapshot): CheckCandidate[] {
  const checks: CheckCandidate[] = [];
  for (const file of snapshot.files) {
    if (basename(file.path) === 'package.json') {
      try {
        const pkg = JSON.parse(file.text),
          dir = dirname(file.relative).replaceAll('\\', '/');
        const manager = /^pnpm@/.test(pkg.packageManager)
          ? 'pnpm'
          : /^yarn@/.test(pkg.packageManager)
            ? 'yarn'
            : 'npm';
        for (const kind of ['typecheck', 'lint', 'test', 'check']) {
          if (typeof pkg.scripts?.[kind] !== 'string') continue;
          const prefix =
            dir === '.'
              ? ''
              : manager === 'npm'
                ? ` --prefix ${quote(dir)}`
                : manager === 'pnpm'
                  ? ` --dir ${quote(dir)}`
                  : ` --cwd ${quote(dir)}`;
          checks.push({
            id: `${file.relative}:${kind}`,
            kind,
            command: `${manager}${prefix} run ${kind}`,
            directory: dir,
            localCommand: `${manager} run ${kind}`,
            config: file.relative,
            configHash: file.hash,
          });
        }
      } catch {
        /* Invalid package metadata is not an executable check. */
      }
    }
    if (file.relative === 'pyproject.toml' || file.relative === 'pytest.ini') {
      for (const [kind, pattern, command] of [
        ['test', /\[tool\.pytest|\[pytest\]/, 'python -m pytest'],
        ['lint', /\[tool\.ruff/, 'python -m ruff check .'],
        ['typecheck', /\[tool\.mypy/, 'python -m mypy .'],
      ] as const)
        if (pattern.test(file.text))
          checks.push({
            id: `${file.relative}:${kind}`,
            kind,
            command,
            directory: '.',
            localCommand: command,
            config: file.relative,
            configHash: file.hash,
          });
    }
  }
  return checks.slice(0, 32);
}

export function matchCheck(command: string, checks: CheckCandidate[], directory = '.') {
  const value = command.trim();
  const matches = (expected: string) =>
    expected === value || (expected === 'npm run test' && value === 'npm test');
  return checks.find(
    (c) =>
      (directory === '.' && matches(c.command)) || (directory === c.directory && matches(c.localCommand)),
  );
}

/** Parse common tsc / ESLint unix / pytest / Ruff diagnostics, retaining unparsed output separately. */
export function diagnostics(output: string): Diagnostic[] {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const result: Diagnostic[] = [];
  for (const text of clean.split(/\r?\n/)) {
    const m = text.match(/^(.+?)\((\d+),(\d+)\):\s*(.+)$/) ?? text.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/);
    if (m)
      result.push({
        path: m[1].trim().slice(0, 1000),
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : null,
        message: m[4].slice(0, 1200),
      });
    if (result.length >= 40) break;
  }
  return result;
}

export function isCriterion(path: string) {
  return /(^|\/)(tests?|__tests__)(\/|\.)|\.(test|spec)\.|(^|\/)(package(-lock)?\.json|.*lock.*|tsconfig.*|.*\.config\..*|pyproject\.toml|pytest\.ini|setup\.cfg|requirements.*)$/i.test(
    path,
  );
}
