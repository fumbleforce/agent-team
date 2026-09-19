import { type Kysely, sql } from 'kysely';
import type { MigrationContext } from '../contract.ts';
import { tokensOf } from '../shared/search.ts';

// Search gets its native index. The documents stay in the portable table and gain two columns: `tokens`, the words of the
// title and body as the shared tokenizer cuts them, and `ref`, where a hit leads. Each dialect then indexes `tokens` its own way.
export async function up(db: Kysely<unknown>, context: MigrationContext): Promise<void> {
  await db.schema.alterTable('search_docs').addColumn('ref', 'text').execute();
  await db.schema.alterTable('search_docs').addColumn('tokens', 'text', c => c.notNull().defaultTo('')).execute();
  // Existing documents are kept: their words are cut here, before the index is built over them.
  const docs = db as Kysely<{ search_docs: { doc_type: string; doc_id: string; title: string; body: string; tokens: string } }>;
  for (const row of await docs.selectFrom('search_docs').select(['doc_type', 'doc_id', 'title', 'body']).execute())
    await docs.updateTable('search_docs').set({ tokens: tokensOf(row.title, row.body) }).where('doc_type', '=', row.doc_type).where('doc_id', '=', row.doc_id).execute();
  await HOOKS[context.dialect](db);
}

const HOOKS: Record<MigrationContext['dialect'], (db: Kysely<unknown>) => Promise<void>> = {
  // An external-content FTS5 table kept in step by triggers. It addresses rows by an integer key, and the implicit rowid of a
  // table without one may be renumbered by VACUUM, so the table is rebuilt with an explicit key first.
  async sqlite(db) {
    const statements = [
      sql`create table search_docs_next (seq integer primary key, doc_type text not null, doc_id text not null, scope_type text not null, scope_id text not null, title text not null, body text not null, ref text, tokens text not null default '', unique (doc_type, doc_id))`,
      sql`insert into search_docs_next (doc_type, doc_id, scope_type, scope_id, title, body, ref, tokens) select doc_type, doc_id, scope_type, scope_id, title, body, ref, tokens from search_docs`,
      sql`drop table search_docs`,
      sql`alter table search_docs_next rename to search_docs`,
      sql`create index search_docs_scope on search_docs (scope_type, scope_id)`,
      sql`create virtual table search_fts using fts5(tokens, content='search_docs', content_rowid='seq', tokenize='unicode61 remove_diacritics 0')`,
      sql`create trigger search_docs_ai after insert on search_docs begin insert into search_fts (rowid, tokens) values (new.seq, new.tokens); end`,
      sql`create trigger search_docs_ad after delete on search_docs begin insert into search_fts (search_fts, rowid, tokens) values ('delete', old.seq, old.tokens); end`,
      sql`create trigger search_docs_au after update on search_docs begin insert into search_fts (search_fts, rowid, tokens) values ('delete', old.seq, old.tokens); insert into search_fts (rowid, tokens) values (new.seq, new.tokens); end`,
      sql`insert into search_fts (search_fts) values ('rebuild')`,
    ];
    for (const statement of statements) await statement.execute(db);
  },
  // The words are already cut, so the vector is built from them as they are, without the text-search parser.
  async postgres(db) {
    await sql`alter table search_docs add column tsv tsvector generated always as (array_to_tsvector(string_to_array(tokens, ' '))) stored`.execute(db);
    await sql`create index search_docs_tsv on search_docs using gin (tsv)`.execute(db);
  },
};
