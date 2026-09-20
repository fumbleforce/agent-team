import type { z } from 'zod';
import { CostRules, DelegationRules, LibraryAgent, ProjectSettings, Role, RoutingRules, TeamTemplate } from '@agent-team/protocol';
import type { ExpressionBuilder } from 'kysely';
import type { Schema, Tx } from '@agent-team/storage';
import { HttpError, notFound, type Context } from '../context.ts';

// Every kind of versioned document and the schema that validates it. Adding a kind is one line here.
export const DOC_KINDS = { role: Role, project_settings: ProjectSettings, team_template: TeamTemplate, library_agent: LibraryAgent, cost_rules: CostRules, routing_rules: RoutingRules, delegation_rules: DelegationRules } as const satisfies Record<string, z.ZodType>;
export type DocKind = keyof typeof DOC_KINDS;
export type DocOf<K extends DocKind> = z.infer<(typeof DOC_KINDS)[K]>;
export interface DocScope { type: 'library' | 'org' | 'team' | 'project'; id: string }
export interface Stored<K extends DocKind> { slug: string; version: number; author: string; updatedAt: number; doc: DocOf<K> }

// One store for every versioned document: save bumps the version, history keeps every one, revert re-saves an old one.
export function createVersionedDocs(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;
  // Both tables share these key columns, so one filter serves them.
  const at = (kind: string, scope: DocScope, slug?: string) => (eb: ExpressionBuilder<Schema, 'versioned_docs' | 'versioned_doc_history'>) =>
    eb.and([eb('kind', '=', kind), eb('scope_type', '=', scope.type), eb('scope_id', '=', scope.id), ...(slug === undefined ? [] : [eb('slug', '=', slug)])]);

  async function write<K extends DocKind>(tx: Tx, kind: K, scope: DocScope, slug: string, input: unknown, author: string, note: string | null, expectedVersion?: number) {
    const parsed = DOC_KINDS[kind].safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const current = await tx.selectFrom('versioned_docs').select('version').where(at(kind, scope, slug)).executeTakeFirst();
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new HttpError(409, 'stale', `The document is at version ${current?.version ?? 0}`);
    const version = (current?.version ?? 0) + 1, doc = JSON.stringify(parsed.data);
    if (current) await tx.updateTable('versioned_docs').set({ version, doc, author, updated_at: now() }).where(at(kind, scope, slug)).execute();
    else await tx.insertInto('versioned_docs').values({ kind, slug, scope_type: scope.type, scope_id: scope.id, version, doc, author, updated_at: now() }).execute();
    await tx.insertInto('versioned_doc_history').values({ kind, slug, scope_type: scope.type, scope_id: scope.id, version, doc, author, note, created_at: now() }).execute();
    return version;
  }

  return {
    async list<K extends DocKind>(kind: K, scope: DocScope): Promise<Stored<K>[]> {
      const rows = await db.selectFrom('versioned_docs').selectAll().where(at(kind, scope)).orderBy('slug').execute();
      return rows.map(row => ({ slug: row.slug, version: row.version, author: row.author, updatedAt: Number(row.updated_at), doc: JSON.parse(row.doc) as DocOf<K> }));
    },

    async get<K extends DocKind>(kind: K, scope: DocScope, slug: string): Promise<Stored<K>> {
      const row = await db.selectFrom('versioned_docs').selectAll().where(at(kind, scope, slug)).executeTakeFirst();
      if (!row) throw notFound(`${kind} "${slug}"`);
      return { slug: row.slug, version: row.version, author: row.author, updatedAt: Number(row.updated_at), doc: JSON.parse(row.doc) as DocOf<K> };
    },

    async save<K extends DocKind>(kind: K, scope: DocScope, slug: string, doc: unknown, options: { author: string; userId?: string; projectId?: string; note?: string; expectedVersion?: number }) {
      const result = await storage.transaction(async tx => {
        const version = await write(tx, kind, scope, slug, doc, options.author, options.note ?? null, options.expectedVersion);
        return { version, published: await events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId: options.userId ?? null, projectId: options.projectId ?? null, payload: { kind, slug, version, scope } }]) };
      });
      events.published(result.published);
      return result.version;
    },

    // Shipped documents are inserted once and never overwrite what an owner changed.
    async seed<K extends DocKind>(kind: K, scope: DocScope, docs: Record<string, unknown>) {
      await storage.transaction(async tx => {
        for (const [slug, doc] of Object.entries(docs)) if (!await tx.selectFrom('versioned_docs').select('version').where(at(kind, scope, slug)).executeTakeFirst()) await write(tx, kind, scope, slug, doc, 'toolkit', 'seeded');
      });
    },

    async history(kind: DocKind, scope: DocScope, slug: string, limit = 30) {
      return db.selectFrom('versioned_doc_history').select(['version', 'author', 'note', 'created_at']).where(at(kind, scope, slug)).orderBy('version', 'desc').limit(limit).execute();
    },

    async revert(kind: DocKind, scope: DocScope, slug: string, version: number, author: string) {
      const old = await db.selectFrom('versioned_doc_history').select('doc').where(at(kind, scope, slug)).where('version', '=', version).executeTakeFirst();
      if (!old) throw notFound(`Version ${version}`);
      return this.save(kind, scope, slug, JSON.parse(old.doc), { author, note: `Reverted to version ${version}` });
    },
  };
}
export type VersionedDocs = ReturnType<typeof createVersionedDocs>;
