import { newId } from '@agent-team/protocol';
import { portableVectors, type Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';
import { lineDiff } from './diff.ts';

export interface Scope { type: 'org' | 'team' | 'project' | 'subproject'; id: string }
export interface Author { kind: 'user' | 'agent' | 'system'; id: string | null }
const PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/;

export type MemorySource = 'agent' | 'remember' | 'owner';
export interface Evidence { kind: 'task' | 'turn' | 'event' | 'review' | 'decision' | 'message'; id: string }
const firstLine = (text: string) => text.trim().split('\n')[0]!.replace(/\s+/g, ' ');
const projectOf = (scope: Scope) => (scope.type === 'project' || scope.type === 'subproject' ? scope.id : null);
const actorIds = (author: Author) => ({ userId: author.kind === 'user' ? author.id : null, agentId: author.kind === 'agent' ? author.id : null });

export interface Embedder { model: string; embed(text: string): Promise<number[]> }
// What counts as near in meaning: cosine similarity, 0 to 1.
const SIMILARITY_FLOOR = 0.6;
// A memory nobody has used for this long is stale.
const STALE_AFTER_MS = 60 * 24 * 3600_000;
// A memory whose turns were sent back this many more times than they passed is taken out of use.
const MISLEADING = -4;

// Embeddings from any endpoint that speaks the common local-model API; without one, search is lexical only.
export function httpEmbedder(url: string, model: string, request: typeof fetch = fetch): Embedder {
  return { model, async embed(text) { const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: text.slice(0, 8000) }), signal: AbortSignal.timeout(20_000) }); return ((await response.json()) as { embedding?: number[] }).embedding ?? []; } };
}

// Where no embedding endpoint is named, a model server on this machine is asked once, on first use, for a model that embeds.
// Without one the search stays lexical; nothing fails because of it.
export function localEmbedder(request: typeof fetch, base = 'http://127.0.0.1:11434'): Embedder {
  let found: Promise<string | null> | null = null;
  const embedder: Embedder = {
    model: '',
    async embed(text) {
      found ??= request(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) }).then(response => (response.ok ? response.json() : null)).then(body => ((body as { models?: { name: string }[] } | null)?.models ?? []).map(model => model.name).find(name => /embed/i.test(name)) ?? null).catch(() => null);
      const model = await found;
      if (!model) return [];
      embedder.model = model;
      return httpEmbedder(`${base}/api/embeddings`, model, request).embed(text);
    },
  };
  return embedder;
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
    // A page is saved with its one-line abstract and short overview; where the writer gives none, they are taken from the page's start.
    async write(author: Author, input: { scope: Scope; path: string; title: string; body: string; abstract?: string | undefined; overview?: string | undefined; note?: string | undefined; expectedRev?: number | undefined }) {
      if (!PATH.test(input.path)) throw new HttpError(400, 'path', 'A page path is lower-case segments ending in .md');
      const result = await storage.transaction(async tx => {
        const page = await tx.selectFrom('kb_pages').selectAll().where('scope_type', '=', input.scope.type).where('scope_id', '=', input.scope.id).where('path', '=', input.path).executeTakeFirst();
        if (page && input.expectedRev !== undefined && input.expectedRev !== page.current_rev) throw new HttpError(409, 'stale', `The page is at revision ${page.current_rev}`);
        const id = page?.id ?? newId(now()), rev = (page ? await lastRev(tx, page.id) : 0) + 1;
        const abstract = (input.abstract?.trim() || firstLine(input.body.replace(/^#.*\n+/, ''))).slice(0, 240), overview = (input.overview?.trim() || input.body.replace(/^#.*\n+/, '').trim()).slice(0, 1200);
        if (page) await tx.updateTable('kb_pages').set({ title: input.title, current_rev: rev, updated_at: now(), abstract, overview }).where('id', '=', id).execute();
        else await tx.insertInto('kb_pages').values({ id, scope_type: input.scope.type, scope_id: input.scope.id, path: input.path, title: input.title, current_rev: rev, archived_at: null, updated_at: now(), abstract, overview }).execute();
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

    // Where a page lives, for callers that must check it belongs to what the viewer may see.
    async pageScope(pageId: string): Promise<Scope | null> {
      const page = await db.selectFrom('kb_pages').select(['scope_type', 'scope_id']).where('id', '=', pageId).executeTakeFirst();
      return page ? { type: page.scope_type as Scope['type'], id: page.scope_id } : null;
    },

    // The history as a person reads it: who, when, their note. `current` is the revision the page shows;
    // `waiting` is a revision kept beside it (a sibling from a sync conflict) that nobody has chosen between yet.
    async historyView(pageId: string) {
      const page = await db.selectFrom('kb_pages').select('current_rev').where('id', '=', pageId).executeTakeFirst();
      if (!page) throw notFound('Page');
      const rows = await this.history(pageId);
      const ids = (kind: string) => [...new Set(rows.filter(row => row.author_kind === kind && row.author_id).map(row => row.author_id!))];
      const users = ids('user').length ? await db.selectFrom('users').select(['id', 'name']).where('id', 'in', ids('user')).execute() : [];
      const agents = ids('agent').length ? await db.selectFrom('agents').select(['id', 'name']).where('id', 'in', ids('agent')).execute() : [];
      const nameOf = (row: (typeof rows)[number]) => row.author_kind === 'user' ? users.find(user => user.id === row.author_id)?.name ?? 'Someone' : row.author_kind === 'agent' ? agents.find(agent => agent.id === row.author_id)?.name ?? 'An agent' : row.author_id === 'folder-sync' ? 'The document folder' : 'The platform';
      return rows.map(row => ({ rev: row.rev_no, author: nameOf(row), authorKind: row.author_kind, note: row.note, at: Number(row.created_at), current: row.rev_no === page.current_rev, waiting: row.rev_no > page.current_rev }));
    },

    async revision(pageId: string, rev: number) {
      const row = await db.selectFrom('kb_revisions').selectAll().where('page_id', '=', pageId).where('rev_no', '=', rev).executeTakeFirst();
      if (!row) throw notFound('Revision');
      return { rev: row.rev_no, body: row.body, note: row.note, at: Number(row.created_at) };
    },

    // What changed from one revision to another; the second defaults to what the page shows now.
    async diff(pageId: string, fromRev: number, toRev?: number) {
      const page = await db.selectFrom('kb_pages').select(['path', 'current_rev']).where('id', '=', pageId).executeTakeFirst();
      if (!page) throw notFound('Page');
      const [from, to] = [await this.revision(pageId, fromRev), await this.revision(pageId, toRev ?? page.current_rev)];
      return { from: from.rev, to: to.rev, ...lineDiff(page.path, from.body, to.body) };
    },

    // Going back is going forward: the old text becomes a new revision, and everything in between stays in the history.
    async restore(author: Author, pageId: string, rev: number) {
      const page = await db.selectFrom('kb_pages').selectAll().where('id', '=', pageId).executeTakeFirst();
      if (!page) throw notFound('Page');
      const old = await this.revision(pageId, rev);
      return this.write(author, { scope: { type: page.scope_type as Scope['type'], id: page.scope_id }, path: page.path, title: page.title, body: old.body, note: `Restored version ${rev}`, expectedRev: page.current_rev });
    },

    // Settles a revision kept beside the current one. Either way a new revision is written, so the choice is on record
    // and the page's number moves past the sibling: "mine" repeats the current text, "theirs" takes the sibling's.
    async resolveSibling(author: Author, pageId: string, rev: number, choice: 'mine' | 'theirs') {
      const page = await db.selectFrom('kb_pages').selectAll().where('id', '=', pageId).executeTakeFirst();
      if (!page) throw notFound('Page');
      if (rev <= page.current_rev) throw new HttpError(409, 'settled', 'That version has already been dealt with');
      const body = (await this.revision(pageId, choice === 'theirs' ? rev : page.current_rev)).body;
      return this.write(author, { scope: { type: page.scope_type as Scope['type'], id: page.scope_id }, path: page.path, title: page.title, body, note: choice === 'theirs' ? 'Used the version from the document folder' : 'Kept this version over the one from the document folder', expectedRev: page.current_rev });
    },

    // A memory is usable as soon as it is filed; one a person confirmed, and one the owner gave, rank above the rest. `abstract` is its
    // one line, what a turn is given when there is room for many; `evidence` is what it came from.
    async fileMemory(input: { scope: Scope; agentId: string | null; type: string; title: string; body: string; abstract?: string | undefined; roleSlug?: string | null | undefined; evidence?: Evidence[] | undefined; source?: MemorySource | undefined; status?: 'filed' | 'confirmed' | undefined }) {
      const id = newId(now());
      const abstract = (input.abstract?.trim() || firstLine(input.body)).slice(0, 240);
      const published = await storage.transaction(async tx => {
        await tx.insertInto('memories').values({ id, scope_type: input.scope.type, scope_id: input.scope.id, agent_id: input.agentId, type: input.type, title: input.title, body: input.body, abstract, role_slug: input.roleSlug ?? null, evidence: JSON.stringify(input.evidence ?? []), source: input.source ?? 'agent', status: input.status ?? 'filed', hits: 0, last_hit_at: null, promoted_page_id: null, created_at: now() }).execute();
        await index(tx, { type: 'memory', id, scope: input.scope, title: input.title, body: `${abstract}\n${input.body}` });
        return events.append(tx, [{ type: 'memory.filed', actorKind: input.agentId ? 'agent' : 'system', agentId: input.agentId, projectId: projectOf(input.scope), payload: { memoryId: id, source: input.source ?? 'agent', ...(input.roleSlug ? { role: input.roleSlug } : {}) } }]);
      });
      events.published(published);
      await embedDoc('memory', id, input.title, `${abstract}\n${input.body}`);
      return id;
    },

    // A newer memory takes the place of older ones: they stay, marked with what replaced them, when and why, so the change can be undone.
    async supersede(by: Author, input: { memoryIds: string[]; by: string; reason: string }) {
      if (input.memoryIds.length === 0) return;
      const published = await storage.transaction(async tx => {
        const rows = await tx.selectFrom('memories').select(['id', 'scope_type', 'scope_id', 'status']).where('id', 'in', input.memoryIds).where('superseded_by', 'is', null).execute();
        if (rows.length === 0) return [];
        await tx.updateTable('memories').set({ status: 'superseded', superseded_by: input.by, superseded_at: now(), supersede_reason: input.reason.slice(0, 400) }).where('id', 'in', rows.map(row => row.id)).execute();
        return events.append(tx, [{ type: 'memory.superseded', actorKind: by.kind, ...actorIds(by), projectId: projectOf({ type: rows[0]!.scope_type as Scope['type'], id: rows[0]!.scope_id }), payload: { memoryIds: rows.map(row => row.id), by: input.by, reason: input.reason.slice(0, 400) } }]);
      });
      events.published(published);
    },

    // Undoing a supersession: the older memory is in use again, and the one that replaced it is retired.
    async restoreMemory(by: Author, memoryId: string) {
      const published = await storage.transaction(async tx => {
        const memory = await tx.selectFrom('memories').select(['id', 'scope_type', 'scope_id', 'superseded_by']).where('id', '=', memoryId).executeTakeFirst();
        if (!memory?.superseded_by) throw new HttpError(409, 'memory', 'That memory was not replaced');
        await tx.updateTable('memories').set({ status: 'confirmed', superseded_by: null, superseded_at: null, supersede_reason: null }).where('id', '=', memoryId).execute();
        await tx.updateTable('memories').set({ status: 'retired' }).where('id', '=', memory.superseded_by).where('status', 'not in', ['retired', 'promoted']).execute();
        return events.append(tx, [{ type: 'memory.restored', actorKind: by.kind, ...actorIds(by), projectId: projectOf({ type: memory.scope_type as Scope['type'], id: memory.scope_id }), payload: { memoryId, retired: memory.superseded_by } }]);
      });
      events.published(published);
    },

    // What the team still holds: filed, confirmed and stale memories. `stale` is true for one marked so, and for one
    // nobody has used in sixty days even if the sweep has not reached it yet.
    // Replaced memories of the last thirty days are listed too, with what replaced them and why, so a replacement can be undone.
    async memories(scope: Scope) {
      const rows = await db.selectFrom('memories').selectAll().where('scope_type', '=', scope.type).where('scope_id', '=', scope.id).where(eb => eb.or([eb('status', 'in', ['filed', 'confirmed', 'stale']), eb.and([eb('status', '=', 'superseded'), eb('superseded_at', '>', now() - 30 * 24 * 3600_000)])])).orderBy('created_at', 'desc').limit(100).execute();
      return rows.map(row => ({ ...row, stale: row.status === 'stale' || Number(row.last_hit_at ?? row.created_at) < now() - STALE_AFTER_MS }));
    },

    async memoryScope(memoryId: string): Promise<Scope | null> {
      const memory = await db.selectFrom('memories').select(['scope_type', 'scope_id']).where('id', '=', memoryId).executeTakeFirst();
      return memory ? { type: memory.scope_type as Scope['type'], id: memory.scope_id } : null;
    },

    // Confirming a stale memory is a person saying it still holds, which counts as a use: the sixty days start again.
    async setMemoryStatus(by: Author, memoryId: string, status: 'confirmed' | 'stale' | 'retired', reason?: string) {
      const published = await storage.transaction(async tx => {
        const memory = await tx.selectFrom('memories').select(['status', 'last_hit_at', 'created_at', 'scope_type', 'scope_id']).where('id', '=', memoryId).executeTakeFirst();
        if (!memory) throw notFound('Memory');
        const wasStale = memory.status === 'stale' || Number(memory.last_hit_at ?? memory.created_at) < now() - STALE_AFTER_MS;
        await tx.updateTable('memories').set(status === 'confirmed' && wasStale ? { status, last_hit_at: now() } : { status }).where('id', '=', memoryId).execute();
        return events.append(tx, [{ type: 'memory.status_changed', actorKind: by.kind, ...actorIds(by), projectId: projectOf({ type: memory.scope_type as Scope['type'], id: memory.scope_id }), payload: { memoryId, from: memory.status, to: status, ...(reason ? { reason: reason.slice(0, 400) } : {}) } }]);
      });
      events.published(published);
    },

    // The stale rule: a filed or confirmed memory with no hit in sixty days (or never hit and filed that long ago) is marked
    // stale. Stale memories stop being injected into turns and wait for a person to review them.
    async sweepStale(): Promise<number> {
      const before = now() - STALE_AFTER_MS;
      // Unused for sixty days, or given to turns whose work kept being sent back: either way it waits for a person before it is given again.
      const rows = await db.selectFrom('memories').select('id').where('status', 'in', ['filed', 'confirmed']).where(eb => eb.or([eb('last_hit_at', '<', before), eb.and([eb('last_hit_at', 'is', null), eb('created_at', '<', before)]), eb('score', '<=', MISLEADING)])).limit(500).execute();
      if (rows.length === 0) return 0;
      events.published(await storage.transaction(async tx => {
        await tx.updateTable('memories').set({ status: 'stale' }).where('id', 'in', rows.map(row => row.id)).where('status', 'in', ['filed', 'confirmed']).execute();
        return events.append(tx, [{ type: 'memory.swept', actorKind: 'system', payload: { memoryIds: rows.map(row => row.id), to: 'stale' } }]);
      }));
      return rows.length;
    },

    // A memory becomes a page; the memory stays, pointing at it.
    async promote(author: Author, memoryId: string, pagePath: string) {
      const memory = await db.selectFrom('memories').selectAll().where('id', '=', memoryId).executeTakeFirst();
      if (!memory) throw notFound('Memory');
      const page = await this.write(author, { scope: { type: memory.scope_type as Scope['type'], id: memory.scope_id }, path: pagePath, title: memory.title, body: memory.body, note: 'Promoted from memory' });
      events.published(await storage.transaction(async tx => {
        await tx.updateTable('memories').set({ status: 'promoted', promoted_page_id: page.id }).where('id', '=', memoryId).execute();
        return events.append(tx, [{ type: 'memory.status_changed', actorKind: author.kind, ...actorIds(author), projectId: projectOf({ type: memory.scope_type as Scope['type'], id: memory.scope_id }), payload: { memoryId, from: memory.status, to: 'promoted', pageId: page.id } }]);
      }));
      return page;
    },

    // Every term must start a word of the title or body; title hits rank first. Pages, memories, messages and issues of the given scopes.
    // `countHits` is for an agent's search: a memory it is handed counts as used. A person browsing does not count.
    async search(scopes: Scope[], query: string, limit = 10, options: { countHits?: boolean } = {}) {
      const found = await (async () => {
        const lexical = await storage.search.query(query, scopes, limit);
        if (!embedder || scopes.length === 0 || lexical.length >= limit) return lexical;
        // Meaning fills what the words missed: the nearest documents of the same scopes, above a similarity floor.
        const target = await embedder.embed(query).catch(() => []);
        if (target.length === 0) return lexical;
        const near = (await vectors.nearest(target, embedder.model, scopes, limit, SIMILARITY_FLOOR)).filter(item => !lexical.some(hit => hit.type === item.type && hit.id === item.id));
        return [...lexical, ...near.slice(0, limit - lexical.length).map(({ similarity: _similarity, ...hit }) => hit)];
      })();
      const memoryIds = options.countHits ? found.filter(hit => hit.type === 'memory').map(hit => hit.id) : [];
      if (memoryIds.length) await db.updateTable('memories').set(eb => ({ hits: eb('hits', '+', 1), last_hit_at: now() })).where('id', 'in', memoryIds).execute();
      return found;
    },
  };
}
export type Knowledge = ReturnType<typeof createKnowledge>;
