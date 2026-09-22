import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// What a team delivers, counted: a duty may ask for a number of deliverables of one kind each time it comes round, and each one handed
// in is kept with its state, so a round shows how far it is and an approved one can be acted on (a message becomes a handoff to send).
export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  await db.schema.alterTable('duties').addColumn('deliverable_kind', 'text').execute();
  await db.schema.alterTable('duties').addColumn('target', 'integer').execute();
  // When the current round began; a change duty counts what merged since then.
  await db.schema.alterTable('duties').addColumn('round_at', 'bigint').execute();
  await db.schema.createTable('deliverables').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('task_id', 'text', c => c.notNull().references('tasks.id').onDelete('cascade')).addColumn('duty_id', 'text', c => c.references('duties.id').onDelete('set null'))
    .addColumn('kind', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull()).addColumn('link', 'text')
    // JSON of the kind's own fields: to and subject of a message, the name of a record.
    .addColumn('fields', 'text', c => c.notNull().defaultTo('{}'))
    .addColumn('author_agent_id', 'text', c => c.notNull()).addColumn('state', 'text', c => c.notNull()).addColumn('reviewer_agent_id', 'text').addColumn('note', 'text')
    // What it became once approved: the task a card was put on the board as, the handoff a message waits in.
    .addColumn('outcome_ref', 'text').addColumn('created_at', 'bigint', c => c.notNull()).addColumn('decided_at', 'bigint').execute();
  await db.schema.createIndex('deliverables_task').on('deliverables').columns(['task_id', 'state']).execute();
  await db.schema.createIndex('deliverables_project').on('deliverables').columns(['project_id', 'created_at']).execute();
}
