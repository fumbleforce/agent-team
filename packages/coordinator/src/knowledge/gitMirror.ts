import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '../context.ts';

const run = promisify(execFile);
const CURSOR = '.agent-team-sync.json';

// A one-way mirror of the knowledge base into a git repository: one commit per revision, in order, authored by who wrote it.
// The database stays the source of truth; the mirror is for reading, diffing and backing up with ordinary tools.
export function createGitMirror(context: Context, directory: string) {
  const db = context.storage.db;
  const git = (...args: string[]) => run('git', ['-C', directory, ...args], { timeout: 60_000 }).then(result => result.stdout);

  return {
    async sync(): Promise<number> {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!existsSync(path.join(directory, '.git'))) await git('init', '-q', '-b', 'main');
      const cursorFile = path.join(directory, CURSOR);
      const cursor = existsSync(cursorFile) ? (JSON.parse(readFileSync(cursorFile, 'utf8')) as { after: number; seen: string[] }) : { after: 0, seen: [] };
      const revisions = await db.selectFrom('kb_revisions').innerJoin('kb_pages', 'kb_pages.id', 'kb_revisions.page_id')
        .select(['kb_revisions.page_id', 'kb_revisions.rev_no', 'kb_revisions.body', 'kb_revisions.author_kind', 'kb_revisions.author_id', 'kb_revisions.note', 'kb_revisions.created_at', 'kb_pages.scope_type', 'kb_pages.scope_id', 'kb_pages.path', 'kb_pages.title'])
        .where('kb_revisions.created_at', '>=', cursor.after).orderBy('kb_revisions.created_at').orderBy('kb_revisions.rev_no').limit(500).execute();
      let committed = 0;
      for (const revision of revisions) {
        const key = `${revision.page_id}:${revision.rev_no}`;
        if (cursor.seen.includes(key)) continue;
        // Page paths were validated when written: lower-case segments, no dots-only parts, ending in .md.
        const file = path.join(directory, revision.scope_type, revision.scope_id, revision.path);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `# ${revision.title}\n\n${revision.body}\n`);
        const at = Number(revision.created_at);
        cursor.seen = at === cursor.after ? [...cursor.seen, key] : [key];
        cursor.after = at;
        writeFileSync(cursorFile, `${JSON.stringify(cursor)}\n`);
        await git('add', '-A');
        const author = `${revision.author_kind}:${revision.author_id ?? 'system'}`;
        await git('-c', `user.name=${author}`, '-c', 'user.email=knowledge@agent-team.invalid', 'commit', '-q', '--allow-empty', '--date', new Date(at).toISOString(), '-m', `${revision.path} r${revision.rev_no}${revision.note ? `: ${revision.note}` : ''}`);
        committed++;
      }
      return committed;
    },
  };
}
