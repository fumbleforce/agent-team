import type { Kysely } from 'kysely';
import type { MigrationContext } from '../contract.ts';

export async function up(db: Kysely<unknown>, context: MigrationContext): Promise<void> {
  const s = db.schema;
  const id = 'text' as const, ms = 'bigint' as const;

  await s.createTable('org').addColumn('id', id, c => c.primaryKey()).addColumn('name', 'text', c => c.notNull())
    .addColumn('accent', 'text', c => c.notNull()).addColumn('currency', 'text', c => c.notNull())
    .addColumn('settings', 'text', c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).execute();

  await s.createTable('users').addColumn('id', id, c => c.primaryKey()).addColumn('email', 'text', c => c.notNull().unique())
    .addColumn('name', 'text', c => c.notNull()).addColumn('password_hash', 'text').addColumn('org_role', 'text', c => c.notNull())
    .addColumn('status', 'text', c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).addColumn('last_login_at', ms).execute();
  await s.createTable('identities').addColumn('user_id', id, c => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('issuer', 'text', c => c.notNull()).addColumn('subject', 'text', c => c.notNull())
    .addPrimaryKeyConstraint('identities_pk', ['issuer', 'subject']).execute();
  await s.createTable('sessions').addColumn('id', id, c => c.primaryKey()).addColumn('user_id', id, c => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('token_hash', 'text', c => c.notNull().unique()).addColumn('created_at', ms, c => c.notNull()).addColumn('expires_at', ms, c => c.notNull())
    .addColumn('last_seen_at', ms, c => c.notNull()).addColumn('revoked_at', ms).execute();
  await s.createTable('invites').addColumn('id', id, c => c.primaryKey()).addColumn('email', 'text', c => c.notNull()).addColumn('org_role', 'text', c => c.notNull())
    .addColumn('project_grants', 'text', c => c.notNull()).addColumn('token_hash', 'text', c => c.notNull().unique())
    .addColumn('invited_by', id, c => c.notNull().references('users.id')).addColumn('expires_at', ms, c => c.notNull()).addColumn('accepted_at', ms).execute();
  await s.createTable('setup_tokens').addColumn('token_hash', 'text', c => c.primaryKey()).addColumn('expires_at', ms, c => c.notNull()).addColumn('used_at', ms).execute();
  await s.createTable('machine_tokens').addColumn('id', id, c => c.primaryKey()).addColumn('name', 'text', c => c.notNull())
    .addColumn('token_hash', 'text', c => c.notNull().unique()).addColumn('kind', 'text', c => c.notNull()).addColumn('created_by', id)
    .addColumn('created_at', ms, c => c.notNull()).addColumn('revoked_at', ms).execute();

  await s.createTable('teams').addColumn('id', id, c => c.primaryKey()).addColumn('scope', 'text', c => c.notNull()).addColumn('project_id', id)
    .addColumn('name', 'text', c => c.notNull()).addColumn('template_slug', 'text').addColumn('template_version', 'integer').execute();
  await s.createTable('projects').addColumn('id', id, c => c.primaryKey()).addColumn('slug', 'text', c => c.notNull().unique()).addColumn('name', 'text', c => c.notNull())
    .addColumn('kind', 'text', c => c.notNull()).addColumn('parent_id', id, c => c.references('projects.id').onDelete('cascade'))
    .addColumn('status', 'text', c => c.notNull()).addColumn('manifest', 'text', c => c.notNull()).addColumn('manifest_sha', 'text')
    .addColumn('team_id', id, c => c.references('teams.id')).addColumn('sort', 'integer', c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('projects_parent').on('projects').column('parent_id').execute();
  await s.createTable('project_members').addColumn('project_id', id, c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('user_id', id, c => c.notNull().references('users.id').onDelete('cascade')).addColumn('role', 'text', c => c.notNull())
    .addPrimaryKeyConstraint('project_members_pk', ['project_id', 'user_id']).execute();
  await s.createTable('milestones').addColumn('id', id, c => c.primaryKey()).addColumn('project_id', id, c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('label', 'text', c => c.notNull()).addColumn('due_at', ms).addColumn('state', 'text', c => c.notNull()).execute();

  await s.createTable('providers').addColumn('id', id, c => c.primaryKey()).addColumn('name', 'text', c => c.notNull()).addColumn('kind', 'text', c => c.notNull())
    .addColumn('engine', 'text', c => c.notNull()).addColumn('billing', 'text', c => c.notNull()).addColumn('engine_config', 'text', c => c.notNull())
    .addColumn('models', 'text', c => c.notNull()).addColumn('limits', 'text', c => c.notNull()).addColumn('status', 'text', c => c.notNull()).addColumn('status_detail', 'text').execute();
  await s.createTable('agents').addColumn('id', id, c => c.primaryKey()).addColumn('team_id', id, c => c.notNull().references('teams.id').onDelete('cascade'))
    .addColumn('name', 'text', c => c.notNull()).addColumn('initials', 'text', c => c.notNull()).addColumn('tint', 'text', c => c.notNull())
    .addColumn('title', 'text', c => c.notNull()).addColumn('persona', 'text', c => c.notNull()).addColumn('status', 'text', c => c.notNull())
    .addColumn('provider_id', id, c => c.references('providers.id')).addColumn('model', 'text').addColumn('daily_cap_minor', 'integer')
    .addColumn('is_pm', context.booleanType, c => c.notNull()).addColumn('doing', 'text').addColumn('sort', 'integer', c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('agents_team').on('agents').columns(['team_id', 'sort']).execute();
  await s.createTable('agent_roles').addColumn('agent_id', id, c => c.notNull().references('agents.id').onDelete('cascade')).addColumn('role_slug', 'text', c => c.notNull())
    .addPrimaryKeyConstraint('agent_roles_pk', ['agent_id', 'role_slug']).execute();

  await s.createTable('versioned_docs').addColumn('kind', 'text', c => c.notNull()).addColumn('slug', 'text', c => c.notNull())
    .addColumn('scope_type', 'text', c => c.notNull()).addColumn('scope_id', 'text', c => c.notNull()).addColumn('version', 'integer', c => c.notNull())
    .addColumn('doc', 'text', c => c.notNull()).addColumn('author', 'text', c => c.notNull()).addColumn('updated_at', ms, c => c.notNull())
    .addPrimaryKeyConstraint('versioned_docs_pk', ['kind', 'scope_type', 'scope_id', 'slug']).execute();
  await s.createTable('versioned_doc_history').addColumn('id', context.serialType, c => context.serialColumn(c)).addColumn('kind', 'text', c => c.notNull())
    .addColumn('slug', 'text', c => c.notNull()).addColumn('scope_type', 'text', c => c.notNull()).addColumn('scope_id', 'text', c => c.notNull())
    .addColumn('version', 'integer', c => c.notNull()).addColumn('doc', 'text', c => c.notNull()).addColumn('author', 'text', c => c.notNull())
    .addColumn('note', 'text').addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('versioned_doc_history_key').on('versioned_doc_history').columns(['kind', 'scope_type', 'scope_id', 'slug', 'version']).execute();

  await s.createTable('tasks').addColumn('id', id, c => c.primaryKey()).addColumn('project_id', id, c => c.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('key', 'text', c => c.notNull()).addColumn('source', 'text', c => c.notNull()).addColumn('title', 'text', c => c.notNull()).addColumn('brief', 'text', c => c.notNull())
    .addColumn('tag', 'text').addColumn('priority', 'integer', c => c.notNull()).addColumn('milestone_id', id, c => c.references('milestones.id'))
    .addColumn('state', 'text', c => c.notNull()).addColumn('assignee_agent_id', id, c => c.references('agents.id')).addColumn('author_agent_id', id, c => c.references('agents.id'))
    .addColumn('branch', 'text').addColumn('head_sha', 'text').addColumn('pr_url', 'text').addColumn('blocked_reason', 'text')
    .addColumn('created_at', ms, c => c.notNull()).addColumn('updated_at', ms, c => c.notNull()).addUniqueConstraint('tasks_project_key', ['project_id', 'key']).execute();
  await s.createIndex('tasks_project_state').on('tasks').columns(['project_id', 'state']).execute();

  await s.createTable('threads').addColumn('id', id, c => c.primaryKey()).addColumn('project_id', id, c => c.references('projects.id').onDelete('cascade'))
    .addColumn('kind', 'text', c => c.notNull()).addColumn('subject_type', 'text').addColumn('subject_id', 'text').addColumn('title', 'text', c => c.notNull())
    .addColumn('visibility', 'text', c => c.notNull()).addColumn('owner_user_id', id).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('threads_project_kind').on('threads').columns(['project_id', 'kind']).execute();
  await s.createTable('messages').addColumn('seq', context.serialType, c => context.serialColumn(c)).addColumn('id', id, c => c.notNull().unique())
    .addColumn('thread_id', id, c => c.notNull().references('threads.id').onDelete('cascade')).addColumn('author_kind', 'text', c => c.notNull()).addColumn('author_id', 'text')
    .addColumn('kind', 'text', c => c.notNull()).addColumn('body', 'text', c => c.notNull()).addColumn('payload', 'text', c => c.notNull()).addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createIndex('messages_thread').on('messages').columns(['thread_id', 'seq']).execute();

  await s.createTable('events').addColumn('seq', context.serialType, c => context.serialColumn(c)).addColumn('id', id, c => c.notNull().unique()).addColumn('at', ms, c => c.notNull())
    .addColumn('type', 'text', c => c.notNull()).addColumn('category', 'text', c => c.notNull()).addColumn('project_id', 'text').addColumn('subproject_id', 'text')
    .addColumn('agent_id', 'text').addColumn('user_id', 'text').addColumn('task_id', 'text').addColumn('thread_id', 'text').addColumn('turn_id', 'text')
    .addColumn('actor_kind', 'text', c => c.notNull()).addColumn('payload', 'text', c => c.notNull()).addColumn('idempotency_key', 'text', c => c.unique()).execute();
  await s.createIndex('events_project').on('events').columns(['project_id', 'seq']).execute();
  await s.createIndex('events_category').on('events').columns(['category', 'seq']).execute();

  await s.createTable('attachments').addColumn('id', id, c => c.primaryKey()).addColumn('sha256', 'text', c => c.notNull().unique()).addColumn('bytes', 'integer', c => c.notNull())
    .addColumn('mime', 'text', c => c.notNull()).addColumn('name', 'text', c => c.notNull()).addColumn('storage_kind', 'text', c => c.notNull())
    .addColumn('storage_key', 'text', c => c.notNull()).addColumn('created_by', 'text').addColumn('created_at', ms, c => c.notNull()).execute();
  await s.createTable('links').addColumn('from_type', 'text', c => c.notNull()).addColumn('from_id', 'text', c => c.notNull()).addColumn('to_type', 'text', c => c.notNull())
    .addColumn('to_id', 'text', c => c.notNull()).addColumn('rel', 'text', c => c.notNull()).addColumn('created_at', ms, c => c.notNull())
    .addPrimaryKeyConstraint('links_pk', ['from_type', 'from_id', 'to_type', 'to_id', 'rel']).execute();
  await s.createIndex('links_to').on('links').columns(['to_type', 'to_id']).execute();
}
