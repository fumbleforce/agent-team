import { sql, type Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, _context: MigrationContext): Promise<void> {
  const s = db.schema;
  const ms = 'bigint' as const;

  await s.createTable('workers').addColumn('id', 'text', c => c.primaryKey()).addColumn('name', 'text', c => c.notNull()).addColumn('lanes', 'text', c => c.notNull())
    .addColumn('isolation', 'text', c => c.notNull()).addColumn('providers', 'text', c => c.notNull()).addColumn('projects', 'text', c => c.notNull()).addColumn('last_seen_at', ms, c => c.notNull()).execute();

  await s.createTable('work_items').addColumn('id', 'text', c => c.primaryKey()).addColumn('agent_id', 'text', c => c.notNull().references('agents.id').onDelete('cascade'))
    .addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade')).addColumn('kind', 'text', c => c.notNull()).addColumn('lane', 'text', c => c.notNull())
    .addColumn('task_id', 'text', c => c.references('tasks.id')).addColumn('thread_id', 'text').addColumn('priority_class', 'integer', c => c.notNull()).addColumn('state', 'text', c => c.notNull())
    .addColumn('defer_reason', 'text').addColumn('not_before', ms).addColumn('dedupe_key', 'text').addColumn('cause_event_id', 'text').addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('work_items_pick').on('work_items').columns(['state', 'priority_class', 'created_at']).execute();
  await s.createIndex('work_items_live_dedupe').on('work_items').column('dedupe_key').unique().where(eb => eb.or([eb(sql.ref('state'), '=', 'queued'), eb(sql.ref('state'), '=', 'leased')])).execute();

  await s.createTable('turns').addColumn('id', 'text', c => c.primaryKey()).addColumn('work_item_id', 'text', c => c.notNull().references('work_items.id'))
    .addColumn('agent_id', 'text', c => c.notNull().references('agents.id')).addColumn('project_id', 'text', c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('task_id', 'text', c => c.references('tasks.id')).addColumn('kind', 'text', c => c.notNull()).addColumn('lane', 'text', c => c.notNull()).addColumn('access', 'text', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull()).addColumn('stop_reason', 'text').addColumn('worker_id', 'text', c => c.notNull()).addColumn('lease_token_hash', 'text', c => c.notNull())
    .addColumn('lease_until', ms, c => c.notNull()).addColumn('grants', 'text', c => c.notNull()).addColumn('summary', 'text').addColumn('tokens_in', 'integer', c => c.notNull())
    .addColumn('tokens_out', 'integer', c => c.notNull()).addColumn('cost_minor', 'integer', c => c.notNull()).addColumn('started_at', ms, c => c.notNull()).addColumn('finished_at', ms).execute();
  // The claim's guarantees, held by the database: one running turn per agent and lane, one writer per task.
  await s.createIndex('turns_one_per_agent_lane').on('turns').columns(['agent_id', 'lane']).unique().where(sql.ref('state'), '=', 'running').execute();
  await s.createIndex('turns_one_writer_per_task').on('turns').column('task_id').unique().where(eb => eb.and([eb(sql.ref('state'), '=', 'running'), eb(sql.ref('access'), '=', 'write')])).execute();
  await s.createIndex('turns_lease').on('turns').columns(['state', 'lease_until']).execute();

  await s.createTable('trace_steps').addColumn('turn_id', 'text', c => c.notNull().references('turns.id').onDelete('cascade')).addColumn('seq', 'integer', c => c.notNull())
    .addColumn('at', ms, c => c.notNull()).addColumn('kind', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('detail', 'text')
    .addColumn('status', 'text', c => c.notNull()).addColumn('artifact_id', 'text').addPrimaryKeyConstraint('trace_steps_pk', ['turn_id', 'seq']).execute();

  await s.createTable('quarantines').addColumn('id', 'text', c => c.primaryKey()).addColumn('scope', 'text', c => c.notNull()).addColumn('ref_id', 'text', c => c.notNull())
    .addColumn('turn_id', 'text', c => c.notNull()).addColumn('reason', 'text', c => c.notNull()).addColumn('opened_at', ms, c => c.notNull()).addColumn('released_by', 'text').addColumn('released_at', ms).execute();
  await s.createIndex('quarantines_open').on('quarantines').columns(['scope', 'ref_id']).execute();
}
