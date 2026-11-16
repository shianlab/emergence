import { canonicalPermissionPath } from '../../src/core/adapters/permissions.ts';

/** One explicit human decision, bound to a native call and complete arguments. No shell-variant allowlist. */
export function fixtureDecision(
  value: unknown,
  callId: string,
  fingerprint: string,
): 'allow' | 'deny' | 'cancel' | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const decision = value as Record<string, unknown>;
  if (decision.callId !== callId || decision.fingerprint !== fingerprint) return;
  if (decision.decision !== undefined) {
    if (decision.approved !== undefined) return;
    if (decision.decision === 'allow' || decision.decision === 'deny' || decision.decision === 'cancel')
      return decision.decision;
    return;
  }
  // Read compatibility for an already reviewed phase 3E operator file; identity must still match.
  return decision.approved === true ? 'allow' : undefined;
}

/** Only the explicitly provisioned fixture projects may be used as command cwd. */
export function fixtureWorkdir(workdir: unknown, owner: string, projects: readonly string[]) {
  if (workdir !== undefined && typeof workdir !== 'string') return false;
  try {
    const actual = canonicalPermissionPath(workdir ?? '.', owner);
    return projects.some((project) => canonicalPermissionPath(project, owner) === actual);
  } catch {
    return false;
  }
}

/** Two exact representations of the same authorized byte edit; no extra file or command authority. */
export function fixtureFileOperation(
  name: string,
  args: Record<string, unknown>,
  owner: string,
  projects: readonly string[],
) {
  if (!fixtureWorkdir(owner, owner, projects)) return false;
  const raw = args.file_path ?? args.path;
  if (typeof raw !== 'string') return false;
  try {
    const path = canonicalPermissionPath(raw, owner);
    const notes = canonicalPermissionPath('notes.txt', owner);
    if (name === 'read' || name === 'emergence_inspect')
      return [
        notes,
        canonicalPermissionPath('verify.cjs', owner),
        ...(name === 'emergence_inspect' ? [canonicalPermissionPath('.', owner)] : []),
      ].includes(path);
    if (path !== notes) return false;
    if (name === 'write') return args.content === '欢迎使用涌现\n';
    return (
      name === 'edit' &&
      ((args.old_string === 'Welcome' && args.new_string === '欢迎使用涌现') ||
        (args.old_string === 'Welcome\n' && args.new_string === '欢迎使用涌现\n'))
    );
  } catch {
    return false;
  }
}
