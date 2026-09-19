import type { Generated } from 'kysely';

// JSON columns hold opaque documents as text in every dialect; anything filtered or sorted is a real column.
type Json = string;
type Ms = number;

export interface OrgTable { id: string; name: string; accent: string; currency: string; settings: Json; created_at: Ms }
export interface UsersTable { id: string; email: string; name: string; password_hash: string | null; org_role: string; status: string; created_at: Ms; last_login_at: Ms | null }
export interface IdentitiesTable { user_id: string; issuer: string; subject: string }
export interface SessionsTable { id: string; user_id: string; token_hash: string; created_at: Ms; expires_at: Ms; last_seen_at: Ms; revoked_at: Ms | null }
export interface InvitesTable { id: string; email: string; org_role: string; project_grants: Json; token_hash: string; invited_by: string; expires_at: Ms; accepted_at: Ms | null }
export interface ProjectMembersTable { project_id: string; user_id: string; role: string }
export interface SetupTokensTable { token_hash: string; expires_at: Ms; used_at: Ms | null }
export interface MachineTokensTable { id: string; name: string; token_hash: string; kind: string; created_by: string | null; created_at: Ms; revoked_at: Ms | null }

export interface ProjectsTable { id: string; slug: string; name: string; kind: string; parent_id: string | null; status: string; manifest: Json; manifest_sha: string | null; team_id: string | null; sort: number; created_at: Ms }
export interface MilestonesTable { id: string; project_id: string; label: string; due_at: Ms | null; state: string }

export interface TeamsTable { id: string; scope: string; project_id: string | null; name: string; template_slug: string | null; template_version: number | null }
export interface AgentsTable { id: string; team_id: string; name: string; initials: string; tint: string; title: string; persona: string; status: string; provider_id: string | null; model: string | null; daily_cap_minor: number | null; is_pm: boolean; doing: string | null; sort: number; created_at: Ms }
export interface AgentRolesTable { agent_id: string; role_slug: string }
export interface ProvidersTable { id: string; name: string; kind: string; engine: string; billing: string; engine_config: Json; models: Json; limits: Json; status: string; status_detail: string | null }

export interface VersionedDocsTable { kind: string; slug: string; scope_type: string; scope_id: string; version: number; doc: Json; author: string; updated_at: Ms }
export interface VersionedDocHistoryTable { id: Generated<number>; kind: string; slug: string; scope_type: string; scope_id: string; version: number; doc: Json; author: string; note: string | null; created_at: Ms }

export interface TasksTable { id: string; project_id: string; key: string; source: string; title: string; brief: string; tag: string | null; priority: number; milestone_id: string | null; state: string; assignee_agent_id: string | null; author_agent_id: string | null; branch: string | null; head_sha: string | null; pr_url: string | null; blocked_reason: string | null; created_at: Ms; updated_at: Ms }

export interface ThreadsTable { id: string; project_id: string | null; kind: string; subject_type: string | null; subject_id: string | null; title: string; visibility: string; owner_user_id: string | null; created_at: Ms }
export interface MessagesTable { id: string; thread_id: string; seq: Generated<number>; author_kind: string; author_id: string | null; kind: string; body: string; payload: Json; created_at: Ms }

export interface EventsTable { seq: Generated<number>; id: string; at: Ms; type: string; category: string; project_id: string | null; subproject_id: string | null; agent_id: string | null; user_id: string | null; task_id: string | null; thread_id: string | null; turn_id: string | null; actor_kind: string; payload: Json; idempotency_key: string | null }

export interface AttachmentsTable { id: string; sha256: string; bytes: number; mime: string; name: string; storage_kind: string; storage_key: string; created_by: string | null; created_at: Ms }
export interface LinksTable { from_type: string; from_id: string; to_type: string; to_id: string; rel: string; created_at: Ms }

export interface Schema extends RuntimeSchema, KnowledgeSchema, DeliberationSchema, DeliverySchema, ChecksSchema, ProposalsSchema, IssuesSchema, IntegrationsSchema, ProductSchema, SchedulesSchema, EmbeddingsSchema {
  org: OrgTable; users: UsersTable; identities: IdentitiesTable; sessions: SessionsTable; invites: InvitesTable;
  project_members: ProjectMembersTable; setup_tokens: SetupTokensTable; machine_tokens: MachineTokensTable;
  projects: ProjectsTable; milestones: MilestonesTable;
  teams: TeamsTable; agents: AgentsTable; agent_roles: AgentRolesTable; providers: ProvidersTable;
  versioned_docs: VersionedDocsTable; versioned_doc_history: VersionedDocHistoryTable;
  tasks: TasksTable; threads: ThreadsTable; messages: MessagesTable; events: EventsTable;
  attachments: AttachmentsTable; links: LinksTable;
}

// Dialects without a native boolean return 0/1; the adapter maps these columns on read.
export const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set(['is_pm', 'revised', 'blocking', 'extended', 'is_blocking', 'needs_human']);

export interface WorkersTable { id: string; name: string; lanes: Json; isolation: string; providers: Json; projects: Json; last_seen_at: Ms }
export interface WorkItemsTable { id: string; agent_id: string; project_id: string; kind: string; lane: string; task_id: string | null; thread_id: string | null; priority_class: number; state: string; defer_reason: string | null; not_before: Ms | null; dedupe_key: string | null; cause_event_id: string | null; created_at: Ms }
export interface TurnsTable { id: string; work_item_id: string; agent_id: string; project_id: string; task_id: string | null; kind: string; lane: string; access: string; state: string; stop_reason: string | null; worker_id: string; lease_token_hash: string; lease_until: Ms; grants: Json; summary: string | null; tokens_in: number; tokens_out: number; cost_minor: number; started_at: Ms; finished_at: Ms | null }
export interface TraceStepsTable { turn_id: string; seq: number; at: Ms; kind: string; title: string; detail: string | null; status: string; artifact_id: string | null }
export interface QuarantinesTable { id: string; scope: string; ref_id: string; turn_id: string; reason: string; opened_at: Ms; released_by: string | null; released_at: Ms | null }

export interface RuntimeSchema { workers: WorkersTable; work_items: WorkItemsTable; turns: TurnsTable; trace_steps: TraceStepsTable; quarantines: QuarantinesTable }

export interface CostEntriesTable { id: string; turn_id: string | null; agent_id: string | null; project_id: string; provider_id: string | null; billing_kind: string; tokens_in: number; tokens_out: number; amount_minor: number; currency: string; at: Ms }
export interface CostDailyTable { day: string; project_id: string; agent_id: string; amount_minor: number; tokens: number }
export interface BudgetsTable { scope: string; scope_id: string; period: string; amount_minor: number }
export interface KbPagesTable { id: string; scope_type: string; scope_id: string; path: string; title: string; current_rev: number; archived_at: Ms | null; updated_at: Ms }
export interface KbRevisionsTable { page_id: string; rev_no: number; body: string; author_kind: string; author_id: string | null; note: string | null; created_at: Ms }
export interface KbReadsTable { page_id: string; rev_no: number; agent_id: string; turn_id: string | null; at: Ms }
export interface MemoriesTable { id: string; scope_type: string; scope_id: string; agent_id: string | null; type: string; title: string; body: string; status: string; hits: number; last_hit_at: Ms | null; promoted_page_id: string | null; created_at: Ms }
export interface SearchDocsTable { doc_type: string; doc_id: string; scope_type: string; scope_id: string; title: string; body: string }

export interface KnowledgeSchema { cost_entries: CostEntriesTable; cost_daily: CostDailyTable; budgets: BudgetsTable; kb_pages: KbPagesTable; kb_revisions: KbRevisionsTable; kb_reads: KbReadsTable; memories: MemoriesTable; search_docs: SearchDocsTable }

export interface DeliberationsTable { id: string; project_id: string; thread_id: string; kind: string; task_id: string | null; question: string; proposer_agent_id: string; decider_agent_id: string | null; state: string; revised: boolean; blocking: boolean; feedback_deadline: Ms; extended: boolean; created_at: Ms }
export interface DeliberationParticipantsTable { deliberation_id: string; agent_id: string; state: string; stance: string | null; is_blocking: boolean; message_id: string | null }
export interface DecisionsTable { id: string; project_id: string; thread_id: string; message_id: string; deliberation_id: string | null; kind: string; outcome: string; summary: string; needs_human: boolean; resolved_by_user: string | null; resolved_at: Ms | null; created_at: Ms }

export interface DeliberationSchema { deliberations: DeliberationsTable; deliberation_participants: DeliberationParticipantsTable; decisions: DecisionsTable }

export interface ApprovalsTable { id: string; task_id: string; kind: string; agent_id: string; turn_id: string; head_sha: string; verdict: string; findings: Json; summary: string; state: string; created_at: Ms }
export interface MergeQueueTable { id: string; project_id: string; task_id: string; head_sha: string; state: string; reason: string | null; created_at: Ms; finished_at: Ms | null }

export interface DeliverySchema { approvals: ApprovalsTable; merge_queue: MergeQueueTable }

export interface CheckRunsTable { id: string; project_id: string; suite: string; kind: string; branch: string; sha: string | null; status: string; passed: number; failed: number; skipped: number; total: number; duration_ms: number; source: string; created_at: Ms }
export interface CheckCasesTable { run_id: string; name: string; status: string; message: string | null }

export interface ChecksSchema { check_runs: CheckRunsTable; check_cases: CheckCasesTable }

export interface ProposalsTable { id: string; project_id: string; category: string; title: string; why: string; what_changes: string; change: Json; evidence: Json; proposer_agent_id: string; state: string; resolved_by_user: string | null; resolution_note: string | null; created_at: Ms; resolved_at: Ms | null }
export interface ProposalVotesTable { proposal_id: string; agent_id: string; stance: string; note: string }

export interface ProposalsSchema { proposals: ProposalsTable; proposal_votes: ProposalVotesTable }

export interface IssuesTable { id: string; project_id: string; number: number; title: string; body: string; state: string; priority: string; source: string; owner_agent_id: string | null; author_user_id: string | null; thread_id: string; attachment_id: string | null; created_at: Ms; closed_at: Ms | null }

export interface IssuesSchema { issues: IssuesTable }

export interface ConnectionsTable { id: string; project_id: string | null; kind: string; name: string; category: string; mode: string; config: Json; status: string; status_detail: string | null; credential_ref: string | null; last_sync_at: Ms | null; created_at: Ms }
export interface HandoffsTable { id: string; project_id: string; direction: string; source: string; title: string; summary: string; context: Json; attachment_id: string | null; target_task_id: string | null; state: string; picked_by_agent_id: string | null; created_by: string | null; created_at: Ms }

export interface IntegrationsSchema { connections: ConnectionsTable; handoffs: HandoffsTable }

export interface ProductEnvsTable { id: string; project_id: string; name: string; branch: string | null; url: string; source: string; created_at: Ms; last_status: string | null; last_latency_ms: number | null }
// A snapshot starts as a request (state requested, no attachment) and is filled by the capture turn that serves it.
export interface SnapshotsTable { id: string; project_id: string; env_id: string; url: string; viewport: string; state: string; error: string | null; attachment_id: string | null; markers: Json; description: string | null; issue_id: string | null; work_item_id: string | null; requested_by: string | null; created_at: Ms; captured_at: Ms | null }

export interface ProductSchema { product_envs: ProductEnvsTable; snapshots: SnapshotsTable }

export interface SchedulesTable { id: string; project_id: string; kind: string; interval_ms: number; next_at: Ms; last_at: Ms | null }

export interface SchedulesSchema { schedules: SchedulesTable }

export interface EmbeddingsTable { doc_type: string; doc_id: string; model: string; vector: Json }

export interface EmbeddingsSchema { embeddings: EmbeddingsTable }
