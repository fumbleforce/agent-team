import type { Context } from '../context.ts';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const API = 'https://www.googleapis.com';

// Knowledge pages flow out to a document folder, one file per page, updated in place when a page gets a new revision.
// The folder and the token's variable name come from the project's "google-drive" connection; the token itself stays in the environment.
export function createDriveSync(context: Context, options: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}) {
  const env = options.env ?? process.env, request = options.fetch ?? (fetch as unknown as Fetch);
  const db = context.storage.db;

  async function upload(token: string, folder: string, fileId: string | null, name: string, body: string): Promise<string | null> {
    const boundary = 'agent-team-page';
    const metadata = fileId ? { name } : { name, parents: [folder], mimeType: 'text/markdown' };
    const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: text/markdown\r\n\r\n${body}\r\n--${boundary}--`;
    const response = await request(`${API}/upload/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=multipart`, { method: fileId ? 'PATCH' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });
    return response.ok ? ((await response.json()) as { id?: string }).id ?? fileId : null;
  }

  return {
    // Pushes every page whose current revision the folder has not seen. What was pushed is remembered as an external reference on the page.
    async sync(): Promise<number> {
      const connections = await db.selectFrom('connections').select(['project_id', 'config', 'credential_ref']).where('kind', '=', 'google-drive').where('status', '=', 'connected').execute();
      let pushed = 0;
      for (const connection of connections) {
        const token = connection.credential_ref ? env[connection.credential_ref] : undefined;
        const folder = (JSON.parse(connection.config) as { folder?: string }).folder;
        if (!token || !folder || !connection.project_id) continue;
        const subprojects = await db.selectFrom('projects').select('id').where('parent_id', '=', connection.project_id).execute();
        const pages = await db.selectFrom('kb_pages').selectAll().where('scope_id', 'in', [connection.project_id, ...subprojects.map(row => row.id)]).where('archived_at', 'is', null).execute();
        for (const page of pages) {
          const link = await db.selectFrom('links').select(['to_id', 'rel']).where('from_type', '=', 'kb_page').where('from_id', '=', page.id).where('to_type', '=', 'drive_file').executeTakeFirst();
          if (link?.rel === `rev:${page.current_rev}`) continue;
          const revision = await db.selectFrom('kb_revisions').select('body').where('page_id', '=', page.id).where('rev_no', '=', page.current_rev).executeTakeFirstOrThrow();
          const fileId = await upload(token, folder, link?.to_id ?? null, page.path.replaceAll('/', ' › '), `# ${page.title}\n\n${revision.body}\n`).catch(() => null);
          if (!fileId) continue;
          await context.storage.transaction(async tx => {
            await tx.deleteFrom('links').where('from_type', '=', 'kb_page').where('from_id', '=', page.id).where('to_type', '=', 'drive_file').execute();
            await tx.insertInto('links').values({ from_type: 'kb_page', from_id: page.id, to_type: 'drive_file', to_id: fileId, rel: `rev:${page.current_rev}`, created_at: context.now() }).execute();
          });
          pushed++;
        }
      }
      return pushed;
    },
  };
}
