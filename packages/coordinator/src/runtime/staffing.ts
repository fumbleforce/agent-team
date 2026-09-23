import { Role } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import { teamIdOf } from '../repos/issueTasks.ts';
import { rule } from './turnRules.ts';

type Reader = Pick<Tx, 'selectFrom'>;

// The seat that staffs a team is told apart by what its roles allow, not by a name: any role may be given the staffing permission.
async function staffingSeats(db: Reader, projectId: string): Promise<{ id: string; name: string }[]> {
  const teamId = await teamIdOf(db as Tx, projectId);
  if (!teamId) return [];
  const seats = await db.selectFrom('agents').innerJoin('agent_roles', 'agent_roles.agent_id', 'agents.id').select(['agents.id', 'agents.name', 'agent_roles.role_slug']).where('agents.team_id', '=', teamId).where('agents.status', '=', 'active').orderBy('agents.sort').execute();
  if (seats.length === 0) return [];
  const roles = await db.selectFrom('versioned_docs').select(['slug', 'doc']).where('kind', '=', 'role').where('slug', 'in', [...new Set(seats.map(seat => seat.role_slug))]).execute();
  const staffing = new Set(roles.filter(row => Role.safeParse(JSON.parse(row.doc)).data?.permissions.staffing === 'decide').map(row => row.slug));
  return seats.filter((item, index) => staffing.has(item.role_slug) && seats.findIndex(other => other.id === item.id && staffing.has(other.role_slug)) === index).map(item => ({ id: item.id, name: item.name }));
}
export const staffingSeat = async (db: Reader, projectId: string) => (await staffingSeats(db, projectId))[0] ?? null;
// Asked of the seat itself, so one on loan to another project staffs there too.
export async function staffs(db: Reader, agentId: string): Promise<boolean> {
  const roles = await db.selectFrom('agent_roles').innerJoin('versioned_docs', 'versioned_docs.slug', 'agent_roles.role_slug').select('versioned_docs.doc').where('agent_roles.agent_id', '=', agentId).where('versioned_docs.kind', '=', 'role').execute();
  return roles.some(row => Role.safeParse(JSON.parse(row.doc)).data?.permissions.staffing === 'decide');
}

export const STAFFING_RULE = rule('staffing');
