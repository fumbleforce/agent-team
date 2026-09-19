import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// A handoff's target is the team or a task, named by type and id as every other edge is; the day an agent was last
// announced as running on the fallback provider, so that notice is given once a day.
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('handoffs').addColumn('target_type', 'text').execute();
  await db.schema.alterTable('handoffs').addColumn('target_id', 'text').execute();
  const loose = db as Kysely<{ handoffs: { target_type: string | null; target_id: string | null; target_task_id: string | null } }>;
  await loose.updateTable('handoffs').set(eb => ({ target_type: 'task', target_id: eb.ref('target_task_id') })).where('target_task_id', 'is not', null).execute();
  await db.schema.alterTable('agents').addColumn('fallback_noticed_day', 'text').execute();
}
