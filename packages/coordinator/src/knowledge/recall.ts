import type { Tx } from '@agent-team/storage';
import type { TurnKind } from '@agent-team/protocol';

// What a turn is given of what the team has learned: the memories that fit its task, within a budget of tokens for its kind, the most
// fitting few in full and more as their one line. Ranked here, inside the claim, from stored text alone: no model and no network.
const BUDGET: Partial<Record<TurnKind, number>> = { work: 1600, review: 1000, triage: 700, feedback: 500, revise: 500, conclude: 500, reply: 500, ideate: 600, retro: 800 };
// A memory turn is shown its neighbours by `nearest` instead, with their ids, so it can replace them.
const FULL = 3, CANDIDATES = 300;
const tokens = (text: string) => Math.ceil(text.length / 4);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const STOP = new Set('the a an and or of to in on for with is are be it this that as at by from not no but if then when what which who how should must can will into about than there their its was were has have had do does done any all each'.split(' '));
const termsOf = (text: string) => [...new Set(text.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(word => word.length > 2 && !STOP.has(word)))];

export interface Recalled { text: string; items: { id: string; depth: 'full' | 'line' }[] }
interface Row { id: string; title: string; body: string; abstract: string; status: string; source: string; score: number; hits: number; role_slug: string | null; created_at: number | string }

// Standing apart from fit: the owner's word first, then what a person confirmed, then what the outcomes of turns given it said.
const standing = (row: Row) => (row.source === 'owner' ? 6 : 0) + (row.status === 'confirmed' ? 2 : 0) + Math.max(-6, Math.min(6, Number(row.score))) + Math.min(2, Math.log2(1 + Number(row.hits)) / 2);

export async function recall(tx: Tx, input: { turnId: string; kind: TurnKind; agentId: string; projectId: string; taskId: string | null; now: number }): Promise<Recalled> {
  const budget = BUDGET[input.kind] ?? 0;
  if (budget === 0) return { text: '', items: [] };
  const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', input.projectId).executeTakeFirst();
  if (!project) return { text: '', items: [] };
  const roles = (await tx.selectFrom('agent_roles').select('role_slug').where('agent_id', '=', input.agentId).execute()).map(row => row.role_slug);
  const scopes = [{ type: 'project', id: project.id }, { type: 'subproject', id: project.id }, ...(project.parent_id ? [{ type: 'project', id: project.parent_id }] : []), { type: 'org', id: '' }];
  const rows = await tx.selectFrom('memories').select(['id', 'title', 'body', 'abstract', 'status', 'source', 'score', 'hits', 'role_slug', 'created_at']).where('status', 'in', ['filed', 'confirmed'])
    .where(eb => eb.or(scopes.map(scope => (scope.type === 'org' ? eb('scope_type', '=', 'org') : eb.and([eb('scope_type', '=', scope.type), eb('scope_id', '=', scope.id)])))))
    .where(eb => eb.or([eb('role_slug', 'is', null), ...(roles.length ? [eb('role_slug', 'in', roles)] : [])])).orderBy('created_at', 'desc').limit(CANDIDATES).execute() as Row[];

  // What the turn is about: the task as it reads now and where its owner said it stands.
  const task = input.taskId ? await tx.selectFrom('tasks').select(['title', 'brief', 'journal']).where('id', '=', input.taskId).executeTakeFirst() : undefined;
  const about = termsOf(`${task?.title ?? ''} ${task?.title ?? ''} ${task?.brief ?? ''} ${task?.journal ?? ''}`);
  // Pages are pointed to, not given: the few that fit, by their one line and id, for knowledge.read.
  const pageRows = about.length ? await tx.selectFrom('kb_pages').select(['id', 'path', 'title', 'abstract', 'overview']).where('archived_at', 'is', null).where(eb => eb.or(scopes.map(scope => (scope.type === 'org' ? eb('scope_type', '=', 'org') : eb.and([eb('scope_type', '=', scope.type), eb('scope_id', '=', scope.id)]))))).orderBy('updated_at', 'desc').limit(200).execute() : [];
  const pageDocs = pageRows.map(row => new Set(termsOf(`${row.title} ${row.abstract} ${row.overview}`)));
  const pageWeight = new Map(about.map(term => [term, Math.log(1 + pageRows.length / (1 + pageDocs.filter(doc => doc.has(term)).length))]));
  const pageMost = about.reduce((sum, term) => sum + (pageWeight.get(term) ?? 0), 0) || 1;
  const pages = pageRows.map((row, index) => ({ row, fit: about.reduce((sum, term) => sum + (pageDocs[index]!.has(term) ? pageWeight.get(term)! : 0), 0) / pageMost })).filter(item => item.fit > 0.15).sort((a, b) => b.fit - a.fit).slice(0, 3);
  if (rows.length === 0 && pages.length === 0) return { text: '', items: [] };
  // A word most memories share says little; a rare one says a lot.
  const docs = rows.map(row => new Set(termsOf(`${row.title} ${row.abstract} ${row.body}`)));
  const weight = new Map(about.map(term => [term, Math.log(1 + rows.length / (1 + docs.filter(doc => doc.has(term)).length))]));
  const most = about.reduce((sum, term) => sum + (weight.get(term) ?? 0), 0) || 1;
  const ranked = rows.map((row, index) => {
    const fit = about.reduce((sum, term) => sum + (docs[index]!.has(term) ? weight.get(term)! : 0), 0) / most;
    return { row, fit, rank: fit * 10 + standing(row) };
  }).filter(item => item.fit > 0.02 || item.row.source === 'owner' || (item.row.role_slug !== null && roles.includes(item.row.role_slug)) || standing(item.row) >= 4)
    .sort((a, b) => b.rank - a.rank);

  // A resumed session already holds what its earlier turns were given; only a fresh packet starts without it.
  const turn = await tx.selectFrom('turns').select(['session_id', 'context_mode']).where('id', '=', input.turnId).executeTakeFirst();
  const given = turn?.context_mode === 'resume' && turn.session_id ? new Set((await tx.selectFrom('memory_injections').innerJoin('turns', 'turns.id', 'memory_injections.turn_id').select('memory_injections.memory_id').where('turns.session_id', '=', turn.session_id).execute()).map(row => row.memory_id)) : new Set<string>();
  const full: string[] = [], lines: string[] = [], items: Recalled['items'] = [];
  let used = 0;
  for (const { row } of ranked) {
    if (given.has(row.id)) continue;
    const depth = full.length < FULL ? 'full' : 'line';
    const text = depth === 'full' ? `## ${row.title}${row.source === 'owner' ? ' (from the owner)' : ''}\n${clip(row.body, 1200)}` : `- ${row.title}: ${clip(row.abstract || row.body, 240)}`;
    if (used + tokens(text) > budget) { if (depth === 'full') continue; break; }
    (depth === 'full' ? full : lines).push(text); items.push({ id: row.id, depth }); used += tokens(text);
  }
  const pageLines: string[] = [];
  for (const { row } of pages) { const line = `- ${row.title} (${row.path}, knowledge.read ${row.id}): ${clip(row.abstract || row.title, 240)}`; if (used + tokens(line) > budget) break; pageLines.push(line); used += tokens(line); }
  if (items.length === 0 && pageLines.length === 0) return { text: '', items: [] };
  if (items.length) await tx.insertInto('memory_injections').values(items.map(item => ({ turn_id: input.turnId, memory_id: item.id, depth: item.depth, created_at: input.now }))).execute();
  if (items.length) await tx.updateTable('memories').set(eb => ({ hits: eb('hits', '+', 1), last_hit_at: input.now })).where('id', 'in', items.map(item => item.id)).execute();
  const text = ['# What the team has learned that bears on this', 'Kept from earlier work on this project. Where one of these is wrong, or out of date, say so with knowledge.propose_memory.', ...full, ...(lines.length ? ['## More, in a line each (knowledge.search finds the rest)', ...lines] : []), ...(pageLines.length ? ['## Pages that bear on it', ...pageLines] : [])].join('\n\n');
  return { text, items };
}

// The active memories of a project closest in wording to a text: what a memory turn weighs a new memory against.
export async function nearest(tx: Tx, projectId: string, text: string, limit: number): Promise<{ id: string; title: string; abstract: string; body: string; source: string; role_slug: string | null }[]> {
  const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
  if (!project) return [];
  const ids = [project.id, ...(project.parent_id ? [project.parent_id] : [])];
  const rows = await tx.selectFrom('memories').select(['id', 'title', 'abstract', 'body', 'source', 'role_slug']).where('status', 'in', ['filed', 'confirmed']).where(eb => eb.or([eb('scope_type', '=', 'org'), eb('scope_id', 'in', ids)])).orderBy('created_at', 'desc').limit(CANDIDATES).execute();
  const about = termsOf(text), docs = rows.map(row => new Set(termsOf(`${row.title} ${row.abstract} ${row.body}`)));
  const weight = new Map(about.map(term => [term, Math.log(1 + rows.length / (1 + docs.filter(doc => doc.has(term)).length))]));
  return rows.map((row, index) => ({ row, fit: about.reduce((sum, term) => sum + (docs[index]!.has(term) ? weight.get(term)! : 0), 0) })).filter(item => item.fit > 0).sort((a, b) => b.fit - a.fit).slice(0, limit).map(item => item.row);
}
