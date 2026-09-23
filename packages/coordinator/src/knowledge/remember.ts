import type { Context } from '../context.ts';
import type { Knowledge, Scope } from './knowledge.ts';

type Item = { action: 'keep' | 'retire'; type?: string | undefined; title?: string | undefined; abstract?: string | undefined; body?: string | undefined; forRole?: string | undefined; replaces: string[]; fromOwner: boolean; why: string };
export class MemoryRefused extends Error {}

// What a memory turn decided, applied as a whole: every memory it keeps names what it came from, what it replaces is superseded rather
// than deleted, and what it retires says why. Only memories of the turn's own project can be replaced, and a memory is marked as the
// owner's only when the owner said something since the team last kept memories here.
export async function recordMemories(context: Context, knowledge: Knowledge, turn: { id: string; agent_id: string; project_id: string; task_id: string | null }, scope: Scope, items: Item[]) {
  const db = context.storage.db;
  const project = await db.selectFrom('projects').select(['id', 'parent_id', 'team_id']).where('id', '=', turn.project_id).executeTakeFirstOrThrow();
  const projects = [project.id, ...(project.parent_id ? [project.parent_id] : [])];
  const named = [...new Set(items.flatMap(item => item.replaces))];
  const known = named.length ? new Set((await db.selectFrom('memories').select('id').where('id', 'in', named).where('status', 'in', ['filed', 'confirmed']).where(eb => eb.or([eb('scope_type', '=', 'org'), eb('scope_id', 'in', projects)])).execute()).map(row => row.id)) : new Set<string>();
  const unknown = named.filter(id => !known.has(id));
  if (unknown.length) throw new MemoryRefused(`Not memories of this project you can change: ${unknown.join(', ')}`);
  const teamId = project.team_id ?? (project.parent_id ? (await db.selectFrom('projects').select('team_id').where('id', '=', project.parent_id).executeTakeFirst())?.team_id ?? null : null);
  const worn = new Set(teamId ? (await db.selectFrom('agent_roles').innerJoin('agents', 'agents.id', 'agent_roles.agent_id').select('agent_roles.role_slug').where('agents.team_id', '=', teamId).execute()).map(row => row.role_slug) : []);
  for (const item of items) {
    if (item.action === 'keep' && !(item.type && item.title && item.abstract && item.body)) throw new MemoryRefused('A memory to keep needs its type, title, abstract and body');
    if (item.action === 'retire' && item.replaces.length === 0) throw new MemoryRefused('Name the memories to retire in replaces');
    if (item.forRole && !worn.has(item.forRole)) throw new MemoryRefused(`Nobody on this team wears the ${item.forRole} role`);
  }
  // The owner's word is kept as theirs only when there is one to keep.
  const last = await db.selectFrom('turns').select('started_at').where('kind', '=', 'remember').where('state', '=', 'completed').where(eb => (turn.task_id ? eb('task_id', '=', turn.task_id) : eb('project_id', '=', turn.project_id))).orderBy('started_at', 'desc').executeTakeFirst();
  const threads = turn.task_id ? (await db.selectFrom('threads').select('id').where('subject_type', '=', 'task').where('subject_id', '=', turn.task_id).execute()).map(row => row.id) : [];
  const ownerSpoke = threads.length > 0 && Boolean(await db.selectFrom('messages').select('id').where('thread_id', 'in', threads).where('author_kind', '=', 'user').where('created_at', '>', Number(last?.started_at ?? 0)).executeTakeFirst());

  const by = { kind: 'agent' as const, id: turn.agent_id }, evidence = [{ kind: 'turn' as const, id: turn.id }, ...(turn.task_id ? [{ kind: 'task' as const, id: turn.task_id }] : [])];
  const kept: string[] = [];
  let retired = 0;
  for (const item of items) {
    if (item.action === 'retire') { for (const id of item.replaces) { await knowledge.setMemoryStatus(by, id, 'retired', item.why); retired++; } continue; }
    const id = await knowledge.fileMemory({ scope, agentId: turn.agent_id, type: item.type!, title: item.title!, abstract: item.abstract!, body: item.body!, roleSlug: item.forRole ?? null, evidence, source: item.fromOwner && ownerSpoke ? 'owner' : 'remember' });
    if (item.replaces.length) await knowledge.supersede(by, { memoryIds: item.replaces, by: id, reason: item.why });
    kept.push(id);
  }
  return { kept, retired };
}
