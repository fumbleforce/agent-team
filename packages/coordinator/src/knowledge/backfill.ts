import type { Context } from '../context.ts';
import { indexIssue, indexMessage } from './indexing.ts';

// Messages and issues written before they were searchable are indexed once at start-up. Indexing replaces by id, so running it again is harmless;
// a marker in the search index itself tells whether it has run.
export async function backfillSearch(context: Context): Promise<number> {
  const { storage } = context;
  const indexed = new Set((await storage.db.selectFrom('search_docs').select('doc_id').where('doc_type', 'in', ['message', 'issue']).execute()).map(row => row.doc_id));
  const messages = (await storage.db.selectFrom('messages').select(['id', 'thread_id', 'body', 'author_kind']).where('author_kind', '!=', 'system').execute()).filter(row => !indexed.has(row.id));
  const issues = (await storage.db.selectFrom('issues').select(['id', 'project_id', 'number', 'title', 'body', 'thread_id']).execute()).filter(row => !indexed.has(row.id));
  for (let start = 0; start < messages.length; start += 200) await storage.transaction(async tx => { for (const row of messages.slice(start, start + 200)) await indexMessage(storage, tx, { id: row.id, threadId: row.thread_id, body: row.body }); });
  await storage.transaction(async tx => { for (const row of issues) if (row.thread_id) await indexIssue(storage, tx, { id: row.id, projectId: row.project_id, number: Number(row.number), title: row.title, body: row.body, threadId: row.thread_id }); });
  return messages.length + issues.length;
}
