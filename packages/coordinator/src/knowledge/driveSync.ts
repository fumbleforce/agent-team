import { createHash } from 'node:crypto';
import type { Context } from '../context.ts';
import { createKnowledge, type Author, type Scope } from './knowledge.ts';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
const API = 'https://www.googleapis.com';
const SYNC: Author = { kind: 'system', id: 'folder-sync' };
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
// What the folder and the page last agreed on is kept in the link: `rev:<revision>:<content hash>`. Links from before hashes were kept count as changed once.
const parseRel = (rel: string | null | undefined) => { const [, rev, hash] = (rel ?? '').split(':'); return { rev: Number(rev ?? 0), hash: hash ?? null }; };

// Knowledge pages flow out to a document folder, one file per page, updated in place when a page gets a new revision; edits made in the folder flow back as revisions.
// The folder and the token's variable name come from the project's "google-drive" connection; the token itself stays in the environment.
export function createDriveSync(context: Context, options: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}) {
  const env = options.env ?? process.env, request = options.fetch ?? (fetch as unknown as Fetch);
  const db = context.storage.db, knowledge = createKnowledge(context);

  async function targets() {
    const connections = await db.selectFrom('connections').select(['project_id', 'config', 'credential_ref']).where('kind', '=', 'google-drive').where('status', '=', 'connected').execute();
    return connections.flatMap(connection => {
      const token = connection.credential_ref ? env[connection.credential_ref] : undefined, folder = (JSON.parse(connection.config) as { folder?: string }).folder;
      return token && folder && connection.project_id ? [{ token, folder, projectId: connection.project_id }] : [];
    });
  }

  const relink = (pageId: string, fileId: string, rel: string) => context.storage.transaction(async tx => {
    await tx.deleteFrom('links').where('from_type', '=', 'kb_page').where('from_id', '=', pageId).where('to_type', '=', 'drive_file').execute();
    await tx.insertInto('links').values({ from_type: 'kb_page', from_id: pageId, to_type: 'drive_file', to_id: fileId, rel, created_at: context.now() }).execute();
  });

  async function upload(token: string, folder: string, fileId: string | null, name: string, body: string): Promise<string | null> {
    const boundary = 'agent-team-page';
    const metadata = fileId ? { name } : { name, parents: [folder], mimeType: 'text/markdown' };
    const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: text/markdown\r\n\r\n${body}\r\n--${boundary}--`;
    const response = await request(`${API}/upload/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=multipart`, { method: fileId ? 'PATCH' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });
    return response.ok ? ((await response.json()) as { id?: string }).id ?? fileId : null;
  }

  async function list(token: string, folder: string) {
    const files: { id: string; md5Checksum?: string }[] = [];
    const q = encodeURIComponent(`'${folder.replaceAll("'", "\\'")}' in parents and trashed = false`), fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,md5Checksum)');
    let pageToken: string | undefined;
    do {
      const response = await request(`${API}/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Listing the folder failed with ${response.status}`);
      const page = (await response.json()) as { files?: typeof files; nextPageToken?: string };
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  return {
    // Pushes every page whose current revision the folder has not seen. What was pushed is remembered as an external reference on the page.
    async sync(): Promise<number> {
      let pushed = 0;
      for (const { token, folder, projectId } of await targets()) {
        const subprojects = await db.selectFrom('projects').select('id').where('parent_id', '=', projectId).execute();
        const pages = await db.selectFrom('kb_pages').selectAll().where('scope_id', 'in', [projectId, ...subprojects.map(row => row.id)]).where('archived_at', 'is', null).execute();
        for (const page of pages) {
          const link = await db.selectFrom('links').select(['to_id', 'rel']).where('from_type', '=', 'kb_page').where('from_id', '=', page.id).where('to_type', '=', 'drive_file').executeTakeFirst();
          if (link && parseRel(link.rel).rev === page.current_rev) continue;
          const revision = await db.selectFrom('kb_revisions').select('body').where('page_id', '=', page.id).where('rev_no', '=', page.current_rev).executeTakeFirstOrThrow();
          const content = `# ${page.title}\n\n${revision.body}\n`;
          const fileId = await upload(token, folder, link?.to_id ?? null, page.path.replaceAll('/', ' › '), content).catch(() => null);
          if (!fileId) continue;
          await relink(page.id, fileId, `rev:${page.current_rev}:${md5(content)}`);
          pushed++;
        }
      }
      return pushed;
    },

    // Brings in files edited in the folder since the last exchange. Run before `sync`, so a page edited on both sides keeps the remote text as a sibling before the local one goes out.
    async pull(): Promise<number> {
      let pulled = 0;
      for (const { token, folder } of await targets()) {
        for (const file of await list(token, folder).catch(() => [])) {
          if (!file.md5Checksum) continue;
          const link = await db.selectFrom('links').select(['from_id', 'rel']).where('from_type', '=', 'kb_page').where('to_type', '=', 'drive_file').where('to_id', '=', file.id).executeTakeFirst();
          const page = link && await db.selectFrom('kb_pages').selectAll().where('id', '=', link.from_id).where('archived_at', 'is', null).executeTakeFirst();
          if (!link || !page) continue;
          const seen = parseRel(link.rel);
          if (seen.hash === file.md5Checksum) continue;
          const response = await request(`${API}/drive/v3/files/${file.id}?alt=media`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }).catch(() => null);
          if (!response?.ok) continue;
          const text = (await response.text()).replaceAll('\r\n', '\n'), header = /^# (.*)\n+/.exec(text);
          const title = header?.[1]?.trim() || page.title, body = (header ? text.slice(header[0].length) : text).replace(/\n+$/, '');
          const current = await db.selectFrom('kb_revisions').select('body').where('page_id', '=', page.id).where('rev_no', '=', page.current_rev).executeTakeFirstOrThrow();
          // Same text as we hold: only the hash is remembered.
          if (body === current.body.replace(/\n+$/, '') && title === page.title) { await relink(page.id, file.id, `rev:${page.current_rev}:${file.md5Checksum}`); continue; }
          if (page.current_rev > seen.rev) {
            // Edited on both sides: the local revision stays current and goes out on the next sync; the remembered hash keeps this remote text from being recorded twice.
            await knowledge.writeSibling(SYNC, page.id, { body, note: `Folder edit kept beside revision ${page.current_rev}` });
            await relink(page.id, file.id, `rev:${seen.rev}:${file.md5Checksum}`);
          } else {
            const written = await knowledge.write(SYNC, { scope: { type: page.scope_type as Scope['type'], id: page.scope_id }, path: page.path, title, body, note: 'Edited in the folder', expectedRev: page.current_rev }).catch(() => null);
            if (!written) continue;
            await relink(page.id, file.id, `rev:${written.rev}:${file.md5Checksum}`);
          }
          pulled++;
        }
      }
      return pulled;
    },
  };
}
