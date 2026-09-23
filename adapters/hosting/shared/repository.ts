import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SCM_KINDS } from '../../scm/index.ts';

const git = (checkout: string, args: string[]) => { const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', windowsHide: true }); return result.status === 0 ? result.stdout.trim() : ''; };

// `git@host:owner/name.git`, `https://host/owner/name.git`, and the `git+https://`, `git+ssh://` and `git://` forms package.json uses.
export function parseRemote(remote: string): { host: string; repository: string } | null {
  const found = /^(?:[\w.-]+@([\w.-]+):|(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return found ? { host: (found[1] ?? found[2])!, repository: found[3]! } : null;
}

// package.json's `repository`: a URL, `{ url }`, `github:owner/name`, `gitlab:group/project`, or npm's bare `owner/name` for GitHub.
export function packageRepository(field: unknown): { host: string; repository: string } | null {
  const text = typeof field === 'string' ? field : typeof field === 'object' && field !== null && typeof (field as { url?: unknown }).url === 'string' ? (field as { url: string }).url : '';
  const short = /^(?:(github|gitlab):)?([\w.-]+(?:\/[\w.-]+)+)$/.exec(text.trim());
  if (short && (short[1] || !text.includes(':'))) return { host: `${short[1] ?? 'github'}.com`, repository: short[2]!.replace(/\.git$/, '') };
  return parseRemote(text);
}

// Where a checkout's code lives, as far as the checkout itself says: the remote it pushes to, else what package.json names. The main
// branch is the one the remote calls its head, else the branch checked out. Nothing is returned for a host no adapter serves.
export function detectRepository(checkout: string): { scm: { kind: string }; delivery: { repository: string; baseBranch: string } } | null {
  let named: unknown;
  try { named = (JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')) as { repository?: unknown }).repository; } catch { /* no package.json */ }
  const served = (found: { host: string; repository: string } | null) => { const kind = found && SCM_KINDS.find(name => found.host.includes(name)); return kind && /^[\w.-]+(\/[\w.-]+)+$/.test(found.repository) ? { kind, repository: found.repository } : null; };
  const found = served(parseRemote(git(checkout, ['remote', 'get-url', 'origin']))) ?? served(packageRepository(named));
  if (!found) return null;
  const head = git(checkout, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  const current = git(checkout, ['symbolic-ref', '--short', 'HEAD']);
  return { scm: { kind: found.kind }, delivery: { repository: found.repository, baseBranch: head || current || 'main' } };
}
