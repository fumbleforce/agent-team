import type { StorageAdapter, Tx } from '@agent-team/storage';

// Messages and issues are searchable under the knowledge scope of their project, next to its pages and memories.
// Both are indexed in the transaction that writes them, through the adapter's SearchPort.
async function scopeOf(tx: Tx, projectId: string) {
  const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
  return project ? { type: project.parent_id ? 'subproject' : 'project', id: project.id } : null;
}

// Only what the whole team can read: a private thread, or one outside any project, stays out of search. A hit leads to the thread.
export async function indexMessage(storage: StorageAdapter, tx: Tx, message: { id: string; threadId: string; body: string }): Promise<void> {
  const thread = await tx.selectFrom('threads').select(['project_id', 'title', 'visibility']).where('id', '=', message.threadId).executeTakeFirst();
  const scope = thread?.project_id && thread.visibility === 'team' ? await scopeOf(tx, thread.project_id) : null;
  if (thread && scope) await storage.search.index({ type: 'message', id: message.id, scope, title: thread.title, body: message.body, ref: message.threadId }, tx);
}

export async function indexIssue(storage: StorageAdapter, tx: Tx, issue: { id: string; projectId: string; number: number; title: string; body: string; threadId: string }): Promise<void> {
  const scope = await scopeOf(tx, issue.projectId);
  if (scope) await storage.search.index({ type: 'issue', id: issue.id, scope, title: `#${issue.number} ${issue.title}`, body: issue.body, ref: issue.threadId }, tx);
}
