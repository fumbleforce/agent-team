import type { ExpressionBuilder, RawBuilder } from 'kysely';
import type { Schema } from '../schema.ts';
import type { Db, SearchHit, SearchPort, SearchScope, VectorPort } from '../contract.ts';

// One tokenizer for every dialect, applied before anything reaches a native index: lower case, accents folded away,
// words are runs of letters and digits. The native indexes then only ever see plain words separated by single spaces,
// so their own parsers have nothing left to disagree about.
export function words(text: string): string[] {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
export const tokensOf = (title: string, body: string) => [...new Set(words(`${title} ${body}`))].join(' ');
// At most six terms of two characters or more; each is a word prefix.
export const termsOf = (query: string) => [...new Set(words(query).filter(term => term.length > 1))].slice(0, 6);

const CANDIDATES = 200;
const inScopes = (scopes: SearchScope[]) => (eb: ExpressionBuilder<Schema, 'search_docs'>) => eb.or(scopes.map(scope => eb.and([eb('search_docs.scope_type', '=', scope.type), eb('search_docs.scope_id', '=', scope.id)])));
// The excerpt is the start of the body, unless the first word that matched sits further in: then it is the text around that word.
const EXCERPT = 240, LEAD = 80;
function excerptOf(body: string, terms: string[]): string {
  const at = terms.map(term => new RegExp(`(?<![\\p{L}\\p{N}])${term}`, 'iu').exec(body)?.index ?? -1).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  if (at < EXCERPT - LEAD) return body.slice(0, EXCERPT);
  return `…${body.slice(at - LEAD, at - LEAD + EXCERPT)}`;
}
const hitOf = (row: { doc_type: string; doc_id: string; title: string; body: string; ref: string | null }, terms: string[] = []): SearchHit => ({ type: row.doc_type, id: row.doc_id, title: row.title, excerpt: excerptOf(row.body, terms), ref: row.ref });

// Title hits first, then the newest document: ids are time-ordered.
export function rank<T extends { doc_id: string; title: string }>(rows: T[], terms: string[]): T[] {
  const score = (row: T) => { const title = words(row.title); return terms.filter(term => title.some(word => word.startsWith(term))).length; };
  const scored = rows.map(row => ({ row, score: score(row) }));
  return scored.sort((a, b) => b.score - a.score || (a.row.doc_id < b.row.doc_id ? 1 : a.row.doc_id > b.row.doc_id ? -1 : 0)).map(item => item.row);
}

// The documents live in one portable table either way. `matches` is the dialect's part: a condition on `search_docs`
// that holds for the rows whose words start with every term, answered from its native index.
export function createSearch(db: Db, matches: (terms: string[]) => RawBuilder<boolean>): SearchPort {
  return {
    async index(doc, via = db) {
      const row = { scope_type: doc.scope.type, scope_id: doc.scope.id, title: doc.title, body: doc.body, ref: doc.ref ?? null, tokens: tokensOf(doc.title, doc.body) };
      await via.insertInto('search_docs').values({ doc_type: doc.type, doc_id: doc.id, ...row }).onConflict(oc => oc.columns(['doc_type', 'doc_id']).doUpdateSet(row)).execute();
    },
    async remove(doc, via = db) {
      await via.deleteFrom('search_docs').where('doc_type', '=', doc.type).where('doc_id', '=', doc.id).execute();
      await via.deleteFrom('embeddings').where('doc_type', '=', doc.type).where('doc_id', '=', doc.id).execute();
    },
    async query(q, scopes, limit) {
      const terms = termsOf(q);
      if (terms.length === 0 || scopes.length === 0 || limit <= 0) return [];
      const rows = await db.selectFrom('search_docs').select(['doc_type', 'doc_id', 'title', 'body', 'ref']).where(inScopes(scopes)).where(matches(terms)).orderBy('doc_id', 'desc').limit(CANDIDATES).execute();
      return rank(rows, terms).slice(0, limit).map(row => hitOf(row, terms));
    },
  };
}

const cosine = (a: number[], b: number[]) => { let dot = 0, na = 0, nb = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; } return na && nb ? dot / Math.sqrt(na * nb) : 0; };

export const storeVector = (db: Db): VectorPort['store'] => async (doc, model, vector) => {
  const row = { model, vector: JSON.stringify(vector) };
  await db.insertInto('embeddings').values({ doc_type: doc.type, doc_id: doc.id, ...row }).onConflict(oc => oc.columns(['doc_type', 'doc_id']).doUpdateSet(row)).execute();
};

// The default on every dialect: vectors in a plain table, compared here. Good for thousands of documents, not millions.
export function portableVectors(db: Db): VectorPort {
  return {
    store: storeVector(db),
    async nearest(vector, model, scopes, limit, floor) {
      if (scopes.length === 0 || vector.length === 0 || limit <= 0) return [];
      const rows = await db.selectFrom('search_docs').innerJoin('embeddings', join => join.onRef('embeddings.doc_type', '=', 'search_docs.doc_type').onRef('embeddings.doc_id', '=', 'search_docs.doc_id'))
        .select(['search_docs.doc_type', 'search_docs.doc_id', 'search_docs.title', 'search_docs.body', 'search_docs.ref', 'embeddings.vector']).where('embeddings.model', '=', model).where(inScopes(scopes)).limit(2000).execute();
      return rows.map(row => ({ ...hitOf(row), similarity: cosine(vector, JSON.parse(row.vector) as number[]) })).filter(item => item.similarity >= floor).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    },
  };
}
