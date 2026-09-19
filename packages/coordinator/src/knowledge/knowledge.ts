import { newId } from '@agent-team/protocol';
import { portableVectors, type Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';

export interface Scope { type: 'org' | 'team' | 'project' | 'subproject'; id: string }
export interface Author { kind: 'user' | 'agent' | 'system'; id: string | null }
const PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/;
const tokens = (text: string) => Math.ceil(text.length / 4);

export interface Embedder { model: string; embed(text: string): Promise<number[]> }
// What counts as near in meaning: cosine similarity, 0 to 1.
const SIMILARITY_FLOOR = 0.6;

// Embeddings from any endpoint that speaks the common local-model API; without one, search is lexical only.
export function httpEmbedder(url: string, model: string): Embedder {
  return { model, async embed(text) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: text.slice(0, 8000) }), signal: AbortSignal.timeout(20_000) }); return ((await response.json()) as { embedding?: number[] }).embedding ?? []; } };
}

export function createKnowledge(context: Context, embedder: Embedder | null = null) {
  const { storage, events, now } = context;
  const db = storage.db;

  // Search and vectors are the storage adapter's: a native index where the dialect has one, the portable table where it has none.
  const vectors = storage.vectors ?? portableVectors(db);
  const index = (tx: Tx, doc: { type: string; id: string; scope: Scope; title: string; body: string }) => storage.search.index(doc, tx);

  // Best effort and outside the write transaction: a slow or absent model never blocks or fails a save.
  async function embedDoc(type: string, id: string, title: string, body: string) {
    if (!embedder) return;
    const vector = await embedder.embed(`${title}
${body}`).catch(() => []);
    if (vector.length) await vectors.store({ type, id }, embedder.model, vector);
  }

  // Sibling revisions take numbers too, so the next number comes from the revisions, not from the page's current one.
  const lastRev = async (tx: Tx, pageId: string) => Number((await tx.selectFrom('kb_revisions').select(eb => eb.fn.max('rev_no').as('last')).where('page_id', '=', pageId).executeTakeFirst())?.last ?? 0);

  return {
    async tree(scope: Scope) {
      return db.selectFrom('kb_pages').select(['id', 'path', 'title', 'current_rev', 'updated_at']).where('scope_type', '=', scope.type).where('scope_id', '=', scope.id).where('archived_at', 'is', null).orderBy('path').execute();
    },

    // Revisions are append-only; `expectedRev` makes a concurrent edit fail instead of overwriting.
    async write(author: Author, input: { scope: Scope; path: string; title: string; body: string; note?: string | undefined; expectedRev?: number | undefined }) {
      if (!PATH.test(input.path)) throw new HttpError(400, 'path', 'A page path is lower-case segments ending in .md');
      const result = await storage.transaction(async tx => {
        const page = await tx.selectFrom('kb_pages').selectAll().where('scope_type', '=', input.scope.type).where('scope_id', '=', input.scope.id).where('path', '=', input.path).executeTakeFirst();
        if (page && input.expectedRev !== undefined && input.expectedRev !== page.current_rev) throw new HttpError(409, 'stale', `The page is at revision ${page.current_rev}`);
        const id = page?.id ?? newId(now()), rev = (page ? await lastRev(tx, page.id) : 0) + 1;
        if (page) await tx.updateTable('kb_pages').set({ title: input.title, current_rev: rev, updated_at: now() }).where('id', '=', id).execute();
        else await tx.insertInto('kb_pages').values({ id, scope_type: input.scope.type, scope_id: input.scope.id, path: input.path, title: input.title, current_rev: rev, archived_at: null, updated_at: now() }).execute();
        await tx.insertInto('kb_revisions').values({ page_id: id, rev_no: rev, body: input.body, author_kind: author.kind, author_id: author.id, note: input.note ?? null, created_at: now() }).execute();
        await index(tx, { type: 'page', id, scope: input.scope, title: input.title, body: input.body });
        const published = await events.append(tx, [{ type: 'kb.page_revised', actorKind: author.kind, userId: author.kind === 'user' ? author.id : null, agentId: author.kind === 'agent' ? author.id : null, projectId: input.scope.type === 'org' || input.scope.type === 'team' ? null : input.scope.id, payload: { pageId: id, path: input.path, rev } }]);
        return { id, rev, published };
      });
      events.published(result.published);
      await embedDoc('page', result.id, input.title, input.body);
      return { id: result.id, rev: result.rev };
    },

    // A revision kept beside the current one rather than replacing it: the page, its search entry and its current revision stay as they are.
    async writeSibling(author: Author, pageId: string, input: { body: string; note?: string | undefined }) {
      const result = await storage.transaction(async tx => {
        const page = await tx.selectFrom('kb_pages').selectAll().where('id', '=', pageId).executeTakeFirst();
        if (!page) throw notFound('Page');
        const rev = (await lastRev(tx, pageId)) + 1;
        await tx.insertInto('kb_revisions').values({ page_id: pageId, rev_no: rev, body: input.body, author_kind: author.kind, author_id: author.id, note: input.note ?? `Sibling of revision ${page.current_rev}`, created_at: now() }).execute();
        const published = await events.append(tx, [{ type: 'kb.page_conflict', actorKind: author.kind, userId: author.kind === 'user' ? author.id : null, agentId: author.kind === 'agent' ? author.id : null, projectId: page.scope_type === 'org' || page.scope_type === 'team' ? null : page.scope_id, payload: { pageId, path: page.path, rev, siblingOf: page.current_rev } }]);
        return { rev, published };
      });
      events.published(result.published);
      return { id: pageId, rev: result.rev };
    },

    async read(pageId: string, reader?: { agentId: string; turnId: string | null }) {
      const page = await db.selectFrom('kb_pages').selectAll().where('id', '=', pageId).executeTakeFirst();
      if (!page) throw notFound('Page');
      const revision = await db.selectFrom('kb_revisions').selectAll().where('page_id', '=', pageId).where('rev_no', '=', page.current_rev).executeTakeFirstOrThrow();
      if (reader) await db.insertInto('kb_reads').values({ page_id: pageId, rev_no: page.current_rev, agent_id: reader.agentId, turn_id: reader.turnId, at: now() }).execute();
      const since = now() - 24 * 3600_000;
      const readers = await db.selectFrom('kb_reads').select('agent_id').distinct().where('page_id', '=', pageId).where('at', '>=', since).execute();
      return { id: page.id, path: page.path, title: page.title, rev: page.current_rev, body: revision.body, authorKind: revision.author_kind, authorId: revision.author_id, updatedAt: Number(revision.created_at), readByToday: readers.length };
    },

    async history(pageId: string) {
      return db.selectFrom('kb_revisions').select(['rev_no', 'author_kind', 'author_id', 'note', 'created_at']).where('page_id', '=', pageId).orderBy('rev_no', 'desc').execute();
    },

    async fileMemory(input: { scope: Scope; agentId: string | null; type: string; title: string; body: string }) {
      const id = newId(now());
      const published = await storage.transaction(async tx => {
        await tx.insertInto('memories').values({ id, scope_type: input.scope.type, scope_id: input.scope.id, agent_id: input.agentId, type: input.type, title: input.title, body: input.body, status: 'filed', hits: 0, last_hit_at: null, promoted_page_id: null, created_at: now() }).execute();
        await index(tx, { type: 'memory', id, scope: input.scope, title: input.title, body: input.body });
        return events.append(tx, [{ type: 'memory.filed', actorKind: input.agentId ? 'agent' : 'system', agentId: input.agentId, projectId: input.scope.type === 'project' || input.scope.type === 'subproject' ? input.scope.id : null, payload: { memoryId: id } }]);
      });
      events.published(published);
      await embedDoc('memory', id, input.title, input.body);
      return id;
    },

    async memories(scope: Scope) {
      return db.selectFrom('memories').selectAll().where('scope_type', '=', scope.type).where('scope_id', '=', scope.id).where('status', 'in', ['filed', 'confirmed']).orderBy('created_at', 'desc').limit(100).execute();
    },

    async setMemoryStatus(memoryId: string, status: 'confirmed' | 'stale' | 'retired') {
      await db.updateTable('memories').set({ status }).where('id', '=', memoryId).execute();
    },

    // A memory becomes a page; the memory stays, pointing at it.
    async promote(author: Author, memoryId: string, pagePath: string) {
      const memory = await db.selectFrom('memories').selectAll().where('id', '=', memoryId).executeTakeFirst();
      if (!memory) throw notFound('Memory');
      const page = await this.write(author, { scope: { type: memory.scope_type as Scope['type'], id: memory.scope_id }, path: pagePath, title: memory.title, body: memory.body, note: 'Promoted from memory' });
      await db.updateTable('memories').set({ status: 'promoted', promoted_page_id: page.id }).where('id', '=', memoryId).execute();
      return page;
    },

    // Every term must start a word of the title or body; title hits rank first. Pages, memories, messages and issues of the given scopes.
    async search(scopes: Scope[], query: string, limit = 10) {
      const lexical = await storage.search.query(query, scopes, limit);
      if (!embedder || scopes.length === 0 || lexical.length >= limit) return lexical;
      // Meaning fills what the words missed: the nearest documents of the same scopes, above a similarity floor.
      const target = await embedder.embed(query).catch(() => []);
      if (target.length === 0) return lexical;
      const near = (await vectors.nearest(target, embedder.model, scopes, limit, SIMILARITY_FLOOR)).filter(item => !lexical.some(hit => hit.type === item.type && hit.id === item.id));
      return [...lexical, ...near.slice(0, limit - lexical.length).map(({ similarity: _similarity, ...hit }) => hit)];
    },

    // What a turn starts with: confirmed memories by hits and recency, cut at the token cap; injected ids are counted as hits.
    async assemble(scopes: Scope[], capTokens: number) {
      if (scopes.length === 0 || capTokens <= 0) return { text: '', memoryIds: [] as string[], tokens: 0 };
      const rows = await db.selectFrom('memories').selectAll().where('status', '=', 'confirmed').where(eb => eb.or(scopes.map(scope => eb.and([eb('scope_type', '=', scope.type), eb('scope_id', '=', scope.id)])))).orderBy('hits', 'desc').orderBy('created_at', 'desc').limit(200).execute();
      const parts: string[] = [], memoryIds: string[] = [];
      let used = 0;
      for (const row of rows) {
        const part = `## ${row.title}\n${row.body}\n`;
        if (used + tokens(part) > capTokens) continue;
        parts.push(part); memoryIds.push(row.id); used += tokens(part);
      }
      if (memoryIds.length) await db.updateTable('memories').set(eb => ({ hits: eb('hits', '+', 1), last_hit_at: now() })).where('id', 'in', memoryIds).execute();
      return { text: parts.join('\n'), memoryIds, tokens: used };
    },
  };
}
export type Knowledge = ReturnType<typeof createKnowledge>;
