import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

// What the decision model was asked and answered: a first read of a report before the PM triages it, how hard a task looks
// before its first work turn is routed. Kept in full, with the confidence and what it cost, so the scorecard can say how often
// a seat or a person chose otherwise and what the reads cost. A task's difficulty is a real column: routing rules filter on it.
export async function up(db: Kysely<unknown>, context: MigrationContext): Promise<void> {
  await db.schema.createTable('machine_decisions').addColumn('id', 'text', c => c.primaryKey()).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('task_id', 'text').addColumn('thread_id', 'text').addColumn('purpose', 'text', c => c.notNull())
    .addColumn('model', 'text', c => c.notNull()).addColumn('questions', 'text', c => c.notNull()).addColumn('answers', 'text', c => c.notNull())
    .addColumn('confidence', 'real', c => c.notNull()).addColumn('input_tokens', 'integer', c => c.notNull()).addColumn('usd_micro', 'integer', c => c.notNull())
    .addColumn('applied', context.booleanType, c => c.notNull().defaultTo(false)).addColumn('judged_at', 'bigint').addColumn('overturned_at', 'bigint').addColumn('overturned_by', 'text')
    .addColumn('created_at', 'bigint', c => c.notNull()).execute();
  await db.schema.createIndex('machine_decisions_project').on('machine_decisions').columns(['project_id', 'created_at']).execute();
  await db.schema.createIndex('machine_decisions_thread').on('machine_decisions').columns(['thread_id', 'purpose']).execute();
  await db.schema.createIndex('machine_decisions_task').on('machine_decisions').columns(['task_id', 'purpose']).execute();
  await db.schema.alterTable('tasks').addColumn('difficulty', 'text').execute();
}
