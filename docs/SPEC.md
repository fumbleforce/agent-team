# Fleet spec: agent-team platform and dashboard rewrite

## Context

The design canvas "Fleet" (https://claude.ai/artifact/Kb1zzjG3eJxpWmnKRS3X3m, 15 boards, 17 numbered features) describes a product the current code cannot back. Today the dashboard is one 702-line server-rendered file, the coordinator is 19 SQLite tables without foreign keys or migrations, a run is one engine session for one project at a time, nothing is recorded per agent, and knowledge is a git folder. Most of the 17 features need new data and a new runtime, not new pages.

This document is the target spec. `README.md` and `docs/PLATFORM.md` describe what runs today; each phase in section 18 updates them, and the rules in `AGENTS.md`, when its code lands.

"Fleet" is the working product name; the UI shows the organization's name. The package, CLI and manifest keep the name `agent-team`.

## 1. Decisions (owner-confirmed) and what is dropped

| Area | Decision |
|---|---|
| Language | TypeScript everywhere: every source file, test, script, adapter, hosting entrypoint and the CLI is `.ts` or `.tsx`. No `.mjs` file is written, and none remains once Phase 1 cuts over. The existing `.mjs` files appear in this spec only in section 17, as sources to port or delete. |
| Runtime | Node 24 LTS is the default and the minimum: `engines.node >= 24`, CI, Docker base images, the worker image bake and the preflight check all pin 24. Node runs the `.ts` sources directly (type stripping is on by default in 24), so there is no server build step in a checkout. Erasable syntax only (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `.ts` import specifiers with `rewriteRelativeImportExtensions`): no enums, namespaces or parameter properties. npm publish runs `tsc` in `prepack` and ships `dist/*.js`, because Node refuses to strip types under `node_modules`. |
| Layout | npm workspaces: `packages/protocol`, `packages/coordinator`, `packages/worker`, `packages/web`, `adapters/*`. |
| HTTP | Hono + `@hono/node-server`. One server: JSON API, SSE, platform MCP endpoint, prebuilt web assets. Port 4310 only; 4311 and the dashboard process go away. |
| Schemas | Zod 4, once, in `protocol`. Drives API validation, the typed client, MCP tool schemas and structured engine output. |
| Storage | An adapter kind, not welded to SQLite. SQLite (`node:sqlite`) is the default adapter; Postgres (and therefore Supabase) is the second. Kysely is the single query layer so queries are written once. |
| Spine | Append-only typed event log; read models updated in the same transaction; one resumable SSE stream. |
| Runtime | One engine session per agent (scoped per agent and task), own provider and model, own queue, own worktree per task, scheduled turns under leases. No home-grown agent loop; engines stay CLI adapters. |
| Discussion | Structured deliberation: proposal, one feedback block per relevant teammate in parallel, at most one revision, PM conclusion recorded as a Decision. No free-form chatter. |
| Agent interface | One platform MCP endpoint served by the coordinator. Replaces the `team`/`memory` shims and all agent use of `gh`/`glab`. |
| Users | Multi-user from the start: owner, admin, member, viewer, per-project access, invitations, audit trail. Password and OIDC sign-in. |
| Front end | React 19, Vite, Tailwind v4, Radix primitives (copied in), `cmdk`, `wouter`, `marked` + DOMPurify. Token-driven; enforced by lint. |
| SCM / trackers | GitHub and GitLab SCM held to one contract. Trackers: Linear and GitHub Issues. A GitLab Issues tracker is not in scope. |
| Data | Start clean. No importer from the old database or git memory. |

Dropped or deferred, stated so it is a choice and not an accident:
- Portraits and their generator: the design uses initials tiles. Removed.
- Voice/talk mode: not ported in v1. Reply turns still stream text, so it can return later.
- The separate `pm`, `intake` and `dashboard` processes: PM becomes an agent with `triage`/`conclude`/`retro` turns; intake becomes the coordinator's tracker sync and schedules.
- `.agent-team-result.json`: turns report through platform tools.
- One-shot ephemeral workers keep working only in packet mode (no resume) with the branch pushed at the end of every turn; see 9.9.

## 2. Architecture

```
Browser (React SPA)  --cookie session-->  Coordinator :4310
                                            /api/*    JSON (Hono, Zod)
                                            /api/stream  SSE, Last-Event-ID
                                            /mcp      platform tools for agents (turn token)
                                            /worker/* claim, heartbeat, steps, complete (machine token + lease)
                                            /*        prebuilt web assets
                                          Storage adapter (SQLite | Postgres)  +  Artifacts adapter (local | S3)
                                          In-process services: scheduler, tracker/SCM sync, schedules, rule evaluation
Worker(s)  --outbound HTTP-->  Coordinator
  per turn: worktree -> engine CLI (adapter) -> stream parse -> trace steps, diffs, artifacts -> publish/deliver
```

The coordinator owns all state and all decisions. Workers own checkouts, worktrees, engine logins and secrets, and never receive user sessions. Agents hold only a turn token that is valid while their lease is.

## 3. Repository layout and conventions

```
packages/protocol/src/      ids.ts enums.ts events/ api/ mcp/tools.ts permissions.ts roles.ts deliberation.ts trace.ts manifest.ts
packages/coordinator/src/   server.ts http/{routes per resource} auth/ events/ runtime/{scheduler,turns,sessions,deliberation,delivery,providers,permissions}
                            knowledge/ sync/{tracker,scm,slack} costs/ checks/ mcp/{server,auth,tools/*} repos/ (Kysely queries, one module per table group)
packages/worker/src/        main.ts slots.ts heartbeat.ts turn/ worktree/ trace/ env/allowlist.ts deliver/ platform/ bin/agent-team-call.ts
packages/web/src/           tokens.css ui/ patterns/ features/<screen>/ data/{client,store,stream}.ts routes.tsx dev/gallery.tsx
adapters/storage/           contract.ts schema.ts migrations/ sqlite/ postgres/ contract.test.ts
adapters/{engine,scm,tracker,launcher,artifacts,integration,hosting}/   as today, TypeScript, each kind with contract.ts + contract.test.ts
blueprints/                 default team template, role and skill library, library agents (replaces roles.json, agents/, teams/)
bin/agent-team.ts           CLI
scripts/                    lint-neutral.ts lint-ui.ts lint-sql.ts
```

Rules:
- TypeScript only. `tsconfig.base.json` is strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), with one project reference per workspace. Types come from the Zod schemas by `z.infer`; hand-written duplicate interfaces are not allowed. Tests are `*.test.ts` run by `node --test`. Processes start as `node packages/coordinator/src/main.ts` and `node packages/worker/src/main.ts`. `tsc --noEmit` replaces the syntax-check script.
- Provider-neutral core stays: `scripts/lint-neutral.ts` covers `packages/**` and `blueprints/**`, extended to `.ts/.tsx`. Provider names only under `adapters/`.
- `scripts/lint-sql.ts`: Kysely's raw `sql` tag is allowed only under `adapters/storage/**`.
- `scripts/lint-ui.ts`: see 14.3.
- One validation source: a shape is a Zod schema in `protocol`; nothing re-validates by hand.
- Adapters of one kind share helpers under `adapters/<kind>/shared/` and pass one contract suite.
- Dependency budget. Runtime: `hono`, `@hono/node-server`, `zod`, `kysely`, `openid-client` (brings `jose`, `oauth4webapi`). Optional, loaded only when configured: `pg`, `sqlite-vec`, `fast-xml-parser` (JUnit). Web, build-time only: React, Vite, Tailwind, about seven Radix packages, `cmdk`, `wouter`, `marked`, `dompurify`, `diff`. Dev: `typescript`, `@biomejs/biome`, `vitest`, `@testing-library/react`, `happy-dom`, `@playwright/test`. A new runtime dependency needs the owner's approval.
- CI: `.github/workflows/verify.yml` and an equivalent `.gitlab-ci.yml`, both on Node 24 and running `npm ci`, `npm run check` (tsc, biome, three lints), `npm test`, `npm run build -w packages/web`. The required check keeps the name `verify`.

## 4. Storage adapter

`adapters/storage/contract.ts`:

```ts
interface StorageAdapter {
  dialect: 'sqlite' | 'postgres'
  db: Kysely<Schema>                          // portable query surface used by packages/coordinator/src/repos
  transaction<T>(fn: (tx) => Promise<T>): Promise<T>
  appendLock(tx): Promise<void>               // makes event seq order equal commit order
  claimLock(tx): Promise<void>                // serializes the claim transaction
  search: SearchPort                          // index(doc), remove(doc), query(q, scope, limit)
  vectors?: VectorPort                        // optional semantic search
  bus: EventBusPort                           // notify(seq), subscribe(fn)
  migrate(): Promise<void>; backup?(path): Promise<void>; close(): Promise<void>
}
```

- All storage calls are async, including on the synchronous `node:sqlite` driver.
- Portable subset for domain queries: no JSON operators, no dialect functions; anything filtered or sorted is a real column. JSON columns are opaque documents. Type mapping (json, boolean, bigint timestamps) lives in the adapter.
- Dialect-specific code is confined to named functions in the adapter: locks, upsert-by-expression-key, search, vectors, bus.
- Migrations: numbered TypeScript files using Kysely's schema builder, with a per-dialect hook for search and vector objects. Tracked in a `migrations` table; each runs in a transaction; forward-only.
- IDs: UUIDv7 generated in `protocol/ids.ts` (time-ordered, native `uuid` on Postgres, text on SQLite). Timestamps: integer milliseconds.

| | SQLite adapter (default) | Postgres adapter (Supabase) |
|---|---|---|
| Driver | `node:sqlite` behind a ~60-line Kysely driver; WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL` | `pg`, optional dependency |
| Locks | `BEGIN IMMEDIATE` | `pg_advisory_xact_lock`; claim uses `FOR UPDATE SKIP LOCKED` |
| Event seq | `INTEGER PRIMARY KEY AUTOINCREMENT` | identity column; append lock keeps seq monotonic with commits |
| Search | FTS5 external-content tables with triggers | `tsvector` + GIN |
| Vectors | `sqlite-vec` via `allowExtension` if present | `pgvector` if present |
| Bus | in-process emitter (one coordinator process) | `LISTEN/NOTIFY` on a direct, non-pooled connection |
| Files | artifacts adapter `local` | artifacts adapter `s3` pointed at Supabase Storage's S3 endpoint |

Supabase means the Postgres adapter plus a connection string. No Supabase SDK, and auth stays ours.

Both adapters pass `adapters/storage/contract.test.ts` (migrations, constraints, claim atomicity under concurrency, event ordering, search, upsert helper). SQLite runs always; Postgres runs in CI against a service container from Phase 1 so the abstraction is exercised, and is declared production-ready in Phase 7.

## 5. Data model

Single organization per deployment, so there is no `org_id` column. Tables by domain; JSON columns are marked `{}`. Anything the boards show that is not listed is derived on read.

**Identity and access.** `org` (singleton: name, accent, currency, auth settings `{}`), `users` (email, name, password_hash?, org_role owner|admin|member|viewer, status), `identities` (user, issuer, subject), `sessions` (token_hash, expires_at, last_seen_at, revoked_at), `invites` (email, org_role, project_grants `{}`, token_hash, expires_at, accepted_at), `project_members` (project, user, role admin|member|viewer), `setup_tokens`, `machine_tokens` (named worker/CLI credentials, token_hash, revoked_at).

**Structure.** `projects` (slug, name, kind, `parent_id` for sub-projects with depth <= 2, status active|paused|archived, manifest `{}`, manifest_sha, team_id), `milestones` (sub-project, label, due_at, state), `project_links` (cross-project dependencies shown on the Org board).

**Team.** `teams` (scope org|project, project_id?, name, template slug + version), `agents` (team, name, initials, tint, persona, status active|paused|retired, provider_id, model, daily_cap, is_pm, sort, library slug?), `agent_roles`, `seat_loans` (agent, to_project, state), `workers` (name, last_seen_at, lanes `{}`, isolation strict|isolated, projects `{}`), `providers` (kind subscription|metered|local, engine, billing, engine_config `{}`, models `{}`, limits `{}`), `provider_state` (provider, worker, preflight_ok, window_pct, limited_until).

**Versioned documents.** One generic pair, `versioned_docs` and `versioned_doc_history` (kind, slug, scope_type, scope_id, version, doc `{}`, author, note), with optimistic concurrency on `version`. Kinds, each validated by its Zod schema: `role`, `skill`, `team_template`, `library_agent`, `environment`, `project_settings`, `delegation_rules`, `cost_rules`, `routing_rules`. One reusable module, `packages/coordinator/src/repos/versionedDocs.ts`, serves all kinds.

**Work.** `tasks` (project, sub-project, key, source tracker|internal, title, brief, tags `{}`, priority, milestone, state, assignee_agent, author_agent, branch, base_ref, head_sha, pr_url, publish, auto_merge, approval_required, blocked_reason), `work_items` (agent, kind, task?, deliberation?, thread?, class 1-6, state, defer_reason, not_before, deadline, dedupe_key, cause_event), `turns` (work_item, agent, session?, task?, kind, lane work|bounded|deliver, access write|read|none, worktree?, engine, provider, model, context_mode resume|fork|packet, state, stop_reason, worker, lease_token_hash, lease_until, grants `{}` frozen at claim, head_sha_start/end, tokens_in/out, cost), `agent_sessions` (agent, task?, purpose, engine, provider, model, engine_session_id, worker, worktree, state, context_tokens, turn_count, rotated_from), `worktrees` (task, worker, kind work|review, path, branch, detached_sha, base_commit, excluded_paths `{}`, state), `tool_calls` (turn, seq, tool, args_hash, idempotency_key, result `{}`), `approvals` (task, kind tester|reviewer|pm, agent, session, head_sha, verdict, findings `{}`, state pending-verification|valid|stale), `merge_queue` (project, task, head_sha, state), `quarantines` (scope, ref, turn, opened_at, released_by, resolution), `schedules` (project, kind, interval, next_at).

**Issues and sync.** `issues` (project, number, title, body, state, priority, source product|discussion|agent|tracker|handoff|webhook, owner_agent, author, labels `{}`, thread, snapshot?), `external_refs` (entity_type, entity_id, system, external_id, url, synced_at, remote_version) for tasks, issues, messages and pages alike, `sync_cursors` (connection, resource, cursor, last_ok_at, error).

**Conversation.** `threads` (project, kind discussion|issue|dm|proposal|handoff, subject_type/id, title, visibility team|private), `messages` (thread, seq, author_kind user|agent|system, author_id, kind note|claim|blocker|handoff|question|proposal|feedback|revision|decision|system, body, payload `{}`), `mentions` (message, target agent|role|team|user, expects, state), `deliberations` (thread, kind design|triage|team-proposal|retro|review-dispute, subject, proposer, decider, round, state, feedback_deadline, quorum), `deliberation_participants`, `decisions` (project, thread, message, deliberation?, kind, outcome, summary, needs_human, resolved_by_user, resolved_at), `proposals` (project, category hire|retire|composition|limits|roles|direction|routing, title, why, what_changes, evidence `{}`, cost_delta, deliberation, state needs_you|auto_applied|approved|declined|withdrawn, review_at). Proposal, feedback, revision and decision content are messages with typed payloads, not separate tables.

**Events.** `events` and `trace_steps`; see 6.

**Knowledge.** `kb_pages` (scope_type org|team|project|subproject, scope_id, path, title, current_rev, owners `{}`, archived_at; unique scope + path), `kb_revisions` (page, rev_no, body, author, note, parent_rev), `kb_reads` (page, rev, agent, turn, at), `memories` (scope, author_agent, type observation|gotcha|decision|convention|run, title, body, status filed|confirmed|promoted|stale|retired, hits, last_hit_at, promoted_page), `links` (from_type, from_id, to_type, to_id, rel): the one edge table between issues, tasks, pages, PRs, decisions, threads, attachments, snapshots, handoffs and check cases.

**Files and product.** `attachments` (sha256, bytes, mime, name, storage_kind, storage_key, created_by), `product_envs` (project, name, branch?, url, source scm|manual, last_status, last_latency_ms), `snapshots` (project, env, url, viewport, attachment, markers `{}`, description, issue).

**Costs.** `cost_entries` (turn, agent, project, provider, billing_kind metered|subscription|local, tokens_in/out/cache, amount_minor, currency), `cost_daily` (day, project, agent, provider, amount_minor, tokens; maintained in the same transaction), `budgets` (scope org|project|agent, period, amount_minor).

**Checks.** `check_suites` (project, key, name, kind test|check, owner_agent), `check_runs` (suite, branch, sha, status, passed, failed, skipped, total, duration_ms, source scm|agent|upload, attachment), `check_cases` (run, name, status failed|flaky, message, tags `{}`, owner_agent, issue). Only failing and flaky cases are stored.

**Integrations.** `connections` (project?, kind, name, mode, config `{}`, status, status_detail, credential_ref naming a secret, never its value, roles `{}`, last_sync_at), `handoffs` (project, direction in|out, source, title, summary, context `{}`, target_type/id, state, picked_by_agent).

## 6. Event log and live updates

- Envelope: `seq, id, at, type, category domain|trace|audit, project_id?, subproject_id?, agent_id?, user_id?, task_id?, thread_id?, turn_id?, actor_kind user|agent|system|worker, payload {}, idempotency_key?`. Field names follow the OpenTelemetry GenAI conventions where that costs nothing (`gen_ai.usage.input_tokens` style inside cost and turn payloads).
- One write path: `appendEvents(tx, events)` under `appendLock`, with the read-model updates in the same transaction. Every command handler and every MCP tool call goes through it.
- Catalog, owned by `protocol/events/`: `task.*`, `turn.*`, `session.*`, `message.posted`, `mention.created`, `deliberation.*`, `decision.recorded`, `proposal.*`, `issue.*`, `kb.page_revised`, `memory.*`, `cost.recorded`, `budget.threshold`, `check.run_reported`, `provider.limited`, `agent.*`, `quarantine.*`, `handoff.*`, `sync.*`, `tool.called`, and audit events `auth.*`, `member.*`, `settings.changed`.
- Volume rule: token deltas are never stored. They are relayed on the SSE stream only, and the final text is stored once. Trace steps are rows in `trace_steps`; the log gets one `turn.steps` event per turn per second at most, carrying the step seq range.
- Retention: `audit` and `domain` events are kept. `trace_steps` and their artifacts are kept 30 days after the task is terminal (configurable); raw engine streams are archived as artifacts.
- SSE `/api/stream?scope=...`: snapshot-then-stream. The client loads a view by GET, which returns the `seq` it is current to, then subscribes from that seq; reconnects send `Last-Event-ID` and the server backfills. Events are filtered per viewer by project membership and thread visibility.

## 7. API

Conventions: JSON only; errors `{error: {code, message, fields?}}`; cursor pagination `?after=&limit=`; `Idempotency-Key` header on POSTs that create; `If-Match: <version>` on versioned documents; attachments by `POST /api/attachments` (multipart, size-capped, sha256-deduplicated) and `GET /api/attachments/:id`. The web app uses Hono's typed client `hc<AppType>` from `protocol`.

| Group | Routes (sketch) | Auth |
|---|---|---|
| Auth | `/api/auth/{login,logout,me,oidc/start,oidc/callback,setup,invites/:token}` | public / session |
| Org and members | `/api/org`, `/api/users`, `/api/invites`, `/api/projects/:id/members`, `/api/audit` | admin+ |
| Projects | `/api/projects` (tree), `/:id`, `/:id/settings`, `/:id/milestones`, `/:id/manifest` (machine) | member read, admin write |
| Board | `/api/projects/:id/tasks`, `/api/tasks/:id`, `/:id/{assign,priority,stop,release}` | member |
| Discussion | `/api/threads/:id`, `/:id/messages`, `/api/deliberations/:id`, `/api/decisions`, `/api/needs-you` | member |
| Issues | `/api/projects/:id/issues`, `/api/issues/:id`, `/:id/{close,link}` | member |
| Agents | `/api/agents/:id`, `/:id/{pause,resume,reassign,stop}`, `/:id/trace`, `/:id/dm`, `/api/turns/:id/steps` | member; config admin |
| Team | `/api/teams/:id`, `/api/library/agents`, `/api/templates`, `/api/roles`, `/api/skills`, `/api/providers`, `/api/workers` | admin write |
| Knowledge | `/api/kb/pages`, `/:id`, `/:id/revisions`, `/api/memories`, `/:id/{confirm,promote,retire}`, `/api/search` | member |
| Costs | `/api/costs/{summary,daily,by-agent,by-project,export.csv}`, `/api/budgets`, `/api/rules/:kind` | member read, admin write |
| Checks | `/api/projects/:id/checks/{matrix,failing,health}`, `/api/check-runs` (upload) | member |
| Product | `/api/projects/:id/envs`, `/api/snapshots`, `/:id/issue` | member |
| Proposals | `/api/proposals`, `/:id/{approve,approve-with-changes,decline}`, `/api/rules/delegation` | admin decide |
| Integrations | `/api/connections`, `/api/handoffs`, `/:id/{hand,attach}` | admin / member |
| Workload | `/api/projects/:id/workload`, `/rebalance` (suggest, apply) | member |
| Stream | `/api/stream` | session |
| Worker | `/worker/{register,claim}`, `/worker/turns/:id/{heartbeat,session,steps,artifacts,verify,complete,fail}` | machine token + lease |
| Agents' tools | `POST /mcp` | turn token |

Worker routes keep today's semantics (atomic claim, 90 s lease, heartbeat every third, 409 on lost lease, fail-closed). What changes: the unit is a turn, claim long-polls and carries free lanes and advertised providers, steps replace raw event lines, and completion reports verified head shas.

## 8. Auth and RBAC

- Sessions: opaque 256-bit token, SHA-256 hash stored, `HttpOnly; SameSite=Lax; Secure` (`__Host-` prefix on HTTPS), 30-day sliding expiry, revocable. CSRF: `SameSite=Lax` plus an `Origin`/`Sec-Fetch-Site` check on every non-GET, plus JSON-only bodies.
- Passwords: `crypto.scrypt`, minimum 12 characters, login rate limit per IP and account with lockout.
- OIDC: `openid-client` with discovery, authorization code + PKCE; identities keyed by issuer + subject; optional allowed email domains. Trusted-header mode (for Tailscale Serve's identity header) is accepted only on a loopback bind.
- First run: `up` and `agent-team open` print a one-time `/setup?token=` link (30 minutes) that creates the owner. `AGENT_TEAM_DASHBOARD_PASSWORD` is removed.
- Invitations: single-use link with org role and project grants; email delivery is optional, the link can be copied.
- Machine credentials are separate from user sessions: `AGENT_TEAM_TOKEN` remains the root machine token generated by hosting; named, revocable `machine_tokens` for additional workers; the per-turn token is `turn.<id>.<HMAC(leaseToken,'mcp')>`, derived in `packages/coordinator/src/auth/machine.ts`.

| Action | viewer | member | project admin | org admin | owner |
|---|---|---|---|---|---|
| Read projects they belong to | yes | yes | yes | all | all |
| Post, raise issue or snapshot, reply, 1:1 with an agent, edit knowledge | | yes | yes | yes | yes |
| Pause, stop, reassign, rebalance | | yes | yes | yes | yes |
| Team, roles, providers, integrations, budgets, rules, delegation | | | yes | yes | yes |
| Approve or decline proposals, release a quarantine | | | yes | yes | yes |
| Members and invitations | | | project | yes | yes |
| Org settings, auth config, delete project, manage admins | | | | | yes |

1:1 threads are visible to their author only. Every user action is an event with `user_id`; the audit page is a filtered view of the log.

## 9. Agent runtime

### 9.1 Model
- An **agent** is a seat with persona, roles, provider and model. A **task** is a unit of work tied to a tracker issue or internal. A **turn** is one bounded engine invocation of one agent for one purpose: `work | review | feedback | revise | conclude | triage | reply | retro | ideate`, plus deterministic `publish | deliver` turns with no model. A **work item** is a queued reason to run a turn.
- Sessions are scoped to (agent, task) with the task's worktree as working directory, so a resumed turn re-reads only task-relevant context and the directory never changes. Bounded turns (feedback, revise, conclude, triage, reply, retro) run in fresh "packet" sessions built from a deterministic context packet. Continuity across tasks comes from the agent's notebook (agent-scoped memories) and knowledge.
- Task states: `backlog -> assigned -> in_progress <-> awaiting_decision -> in_review -> approved -> merging -> done`, side states `blocked(reason)`, `quarantined`, `stopped`, `canceled`. Board columns: Backlog; In progress (in_progress, awaiting_decision, blocked, quarantined); Review (in_review, approved, merging); Done.
- Turn states: `running -> completed | failed | deferred | interrupted | timed_out | uncertain`.

### 9.2 Safety invariants (AGENTS.md), preserved
| Invariant | Fleet |
|---|---|
| Atomic claims | One claim transaction: expire, gate, pick, insert turn, lease item. Partial unique indexes: one running turn per session; one per agent per lane; one writer per worktree; one running delivery per project; one live work item per dedupe key. |
| Per-project serialization | Re-scoped to the things that are actually shared: single writer per worktree, per-project merge queue, per-checkout git-admin mutex on the worker, and `maxConcurrentWriters` per project, default 1 and raised explicitly, because worktrees do not isolate ports, databases or containers. |
| Lease validation | Every worker route and every MCP call checks running turn, unexpired lease and token. |
| Fail-stop workers | Heartbeat failure kills the process tree; orphan sweep at worker start. |
| Quarantine after uncertain execution | Scope is the smallest object whose state is unknown: task and worktree for a write turn, the merge-queue entry (queue frozen) for a delivery, the checkout for a git-admin operation. |
| Never auto-reassign | Uncertain turns are never retried or reassigned. Only known states continue on their own: deferred, interrupted, resume-missing before output. |
| Prompts are not isolation | Enforcement matrix in 9.7; `strict` workers refuse turns whose restrictions the engine cannot enforce. |
| Publishing needs authorization | Committed ceiling plus a deterministic publisher; agents cannot push. |

### 9.3 Scheduler
- Pure functions `enqueue(event, snapshot)`, `gate(item, snapshot)`, `pick(snapshot, claim)`, tested on a virtual clock.
- Two lanes per agent, `work` and `bounded`, in parallel. Priority classes: 1 reply to a human; 2 conclude and revise; 3 review, feedback, agent mention; 4 continue current task; 5 new task; 6 retro, ideation. Aging by one class per 30 minutes, never above class 2.
- Wake triggers: task assigned, review requested, deliberation opened, feedback closed, mention, owner 1:1, issue or handoff created (triage to the PM), check failed or changes requested (author), schedule fired, decision recorded.
- Gates before a turn starts, each refusal storing a typed `defer_reason` that the Workload page shows: agent active and task not blocked; provider available, under concurrency and under its window percentage; agent daily cap and project budget (80 % warns once in discussion, 100 % runs only classes 1 and 2); routing rules resolve provider and model, sticky per task for work turns; a worker holds the worktree and session, advertises the provider and has a free lane; the engine can enforce the turn's restrictions.
- Anti-chatter: a mention is a directed request with one reply; mention depth at most 2; at most two wakes per agent per thread per hour; overflow opens a triage item for the PM instead of waking more agents.
- Idle fires once per idle period; `rebalance.suggest` is deterministic and moves queued items only.
- Human controls: pause after turn; pause now (kill at the next step boundary, certain if the tree is confirmed dead, otherwise uncertain); stop task (worktree, branch and draft PR retained); reassign only from a certain state, same worker or a pushed clean branch.

### 9.4 Structured deliberation
1. **Propose**: `deliberation.propose` with summary (<= 120 words), up to four options, recommendation, rationale, evidence refs, audience, urgency. A blocking proposal moves the task to `awaiting_decision` and frees the agent's work lane.
2. **Feedback**: reviewers are selected by a deterministic function (explicit @agent or @role, path or page owners, roles tagged for the subject, standing critics; never the proposer or decider; cap 3, every seat for a team proposal). Each returns exactly one block: stance for|against|neutral, 1-4 points, up to 3 risks with severity, up to 3 conditions, confidence, blocking flag, 1200 characters total. Reviewers do not see each other's blocks.
3. **Revise**: at most once, only if a block is blocking, half are against, or conditions exist. A second revise returns 409.
4. **Conclude**: the PM records outcome, decision, rationale and dissent that must cover every against or blocking block, plus up to six actions. Actions inside the delegation bounds apply in the same transaction; anything outside becomes a "Needs you" decision.
- Windows: 10 minutes blocking, 60 normal, 24 hours retro; quorum half of available reviewers; one extension; a lost feedback turn counts as an abstention.
- Token controls: a 3k-token packet per reviewer (proposal, brief, role-relevant knowledge excerpts, notebook, prior decisions); zero-tool feedback with schema-constrained output by default, tools only when the packet is flagged `needsRepo`; skip rules (no reviewers goes straight to conclude; a question inside one role's `decides` areas is a note, not a deliberation).
- The same machine serves issue triage (zero reviewers, the decision is the first message on the issue), team proposals (every seat votes, then `delegation.evaluate` returns auto-apply or needs-human) and the weekly retro (a stats packet from the event log, one retro turn per active seat, at most three resulting proposals).
- Staffing. A role with the `staffing: decide` permission (shipped as `hr`, hired from the library as Toby) decides who is on the team without a vote: `staffing.review` gives every seat's figures, the limits, the agent library, the templates and the roles; `staffing.decide` makes one change (hire from the library, make a seat from library roles, retire, change title, persona or roles, pause or resume, set a daily cap, add a template's seats). Each decision is a proposal row with its reason and evidence. Inside the owner's limits (`delegation_rules.staffing`: whether the seat decides at all, and the largest team, set on the Team tab) it applies in the same transaction; beyond them, or when it concerns the seat itself, the PM, a cap above the team's own, or the last seat wearing a role, it waits as needs-you. Retiring the PM is refused outright. A retired seat's unfinished tasks return to the backlog, its queued work is dropped, and the PM is woken to place them. The seat is woken by the owner's messages and mentions like anyone, by the PM's mention when the workload note finds nobody free, and by the weekly retro after the other seats' notes. A vote never settles who is on the team: a proposal is filed under what its change does, whatever its proposer called it.
- It renders as a thread: proposal, feedback blocks with stance chips, revision, highlighted decision card.

### 9.5 Engine adapter contract v2 and providers
```ts
interface EngineAdapter {
  name; bin; billingModes; capabilities: EngineCapabilities
  environment(env, ctx): Env            // allowlist-based
  preflight(ctx): Promise<PreflightReport>
  prepare(spec: TurnSpec, dirs): PreparedTurn   // {bin, args, input?, env, files[]}; no secrets in argv
  parse(line, state): EngineEvent[]     // pure; also yields usage, cost, window events
  sessionRef(state): string | null
  classifyExit(exit, state, stderrTail): StopReason
}
```
Capabilities: `resume`, `presetSessionId`, `fork`, `mcp http|stdio|none`, `toolPolicy enforced|config|sandbox|prompt`, `bounded`, `structuredOutput`, `usageLimits windows|detect|none`, `cost usd|tokens|none`, `turnCap`. `ask()` and the first-adapter-wins `parseEventLine` disappear; the worker parses with the turn's own adapter.

- The first engine at v2 is the one that implements today's whole contract; the other three follow in Phase 7. Their resume, MCP-config and sandbox flags are taken from vendor documentation and marked "verify" in the adapter contract fixtures before they are relied on.
- Provider registry entry: `{id, kind, engine, billing, credential {env | worker login}, engineConfig, models[{id, engineModel, contextWindow, prices}], limits, workers}`. Secrets stay on workers, which report presence only. "Not connected" means a failed preflight. The scrub rule that stops a subscription login from silently becoming metered billing is kept; a provider changes only through an explicit routing rule.
- Resume: the worker presets or captures the engine session id and posts it at once. Every resumed turn gets a delta preface (new decisions, review results, mentions, base moved). When resume is unavailable, `buildResumePacket` rebuilds context deterministically from the task brief, decisions, the agent's own required per-turn summaries, git state, open findings and role knowledge. Sessions rotate at a context threshold or on a provider or model change.
- If an engine cannot mount HTTP MCP, the same tools are reachable through a stdio bridge or the `agent-team call <tool> <json>` shim; the token travels in a 0600 file or the environment, never argv.

### 9.6 Platform MCP
`POST /mcp`, hand-rolled JSON-RPC (`initialize`, `tools/list`, `tools/call`), tools only. One registry in `protocol/mcp/tools.ts`: `name -> {input, output, permission, turnKinds, mutating, rateClass}`; coordinator handlers are typed from it and `tools/list` returns only what this turn may call.

Tools: `thread.read`, `discussion.post`, `agent.mention`, `deliberation.{propose,feedback,revise,stand,conclude}`, `triage.decide`, `retro.submit`, `task.{list,claim,update,handoff,review}`, `issue.{create,comment,link}`, `knowledge.{search,read,write,propose_memory}`, `proposal.{create,vote}`, `test.report`, `cost.status`, `handoff.send`.

Every call checks: running turn and live lease; tool allowed for the turn kind; permission present in the grants frozen at claim; every referenced entity in the turn's project; feedback and review turns confined to their own deliberation or task. Mutations are idempotent (`sha256(turn, tool, canonical args)` by default), rate-limited from `tool_calls`, and append `tool.called` plus their domain events in one transaction.

### 9.7 Roles, skills, permissions
- Role = summary, perspective text, skills, graded permissions, knowledge to read first, `decides` areas, approval kinds. Permission keys: `repoRead`, `codeWrite` (path-scoped), `shell none|restricted|full`, `browser`, `issues`, `comms`, `deploy`, `secrets`, `spendDailyCap`, `integrations`, `delegate`.
- A skill is a versioned `skill` document in the library scope: a "use when" description, a Markdown method, the files it refers to, whether it is always applied, and where it came from (repository, folder, commit, license, author). A role names its skills. A seat's standing prompt carries the full text of its always-applied skills and one line for each of the rest, which the agent reads with `skill.read` when the work calls for it. Skill text is context, not enforcement: the grants below still bound what a seat can do. `blueprints/skills` ships skills as their authors wrote them, with their licenses; they are seeded like every shipped document, and one nobody edited follows the shipped library. More are imported from a folder on a code host (`adapters/skills`: a look at what is new, changed or the same, then the ones chosen) or written in the app, and every change is a version that can be put back.
- Effective grant = `meet(join(role grants), project ceiling, committed ceiling, agent tightenings)`, pure lattice functions in `protocol/permissions.ts`. The worker re-meets against the ceiling read from the primary checkout at the base commit, so the committed file wins even if the coordinator is wrong.
- The committed ceiling is a `ceiling` section in `.agent-team.json` version 3: per-key maximum, bash deny rules, delivery gates, required approval kinds, `publishAuthorized`, sensitive-path additions, allowed integrations, and the floor for roles created in the UI (read-only, which also closes today's floor that denies neither edit nor bash).
- Enforcement: read scope by sparse checkout; write scope by engine rules where they exist and always by a post-turn diff gate on the worker; shell by tool removal, sandbox mode or deny rules (`restricted` is never labelled a sandbox unless the launcher isolates); browser and integrations mounted only when granted, credentials injected by the worker as today; issues, comms, knowledge and proposals enforced server-side at the MCP; secrets by an environment allowlist that replaces today's denylist; spend by the pre-turn gate. Persona, perspective, skill bodies and page titles are context, not enforcement.

### 9.8 Worktrees, publish, approvals, merge
- One work worktree per task, reused across turns, built by the ported runner sequence (container, ancestor validation, base inspection, no-checkout add, sparse exclusions, checkout, exclusion verification, overlays). Review and test worktrees are detached at the head sha with the same exclusions.
- Publish is worker code: diff gate, push without force, then a new SCM adapter method `publish()` that creates or updates the draft change. Both SCM adapters implement it; `publishInstructions` prose goes away.
- A change has one approval, the reviewer's: written only by `task.review` in a review turn, by the team's reviewer (who runs the change and checks it against its brief), never the author. The PM agrees the brief at triage and does not review the result. An approval becomes valid when the worker reports the verified head sha and goes stale on any head change.
- `deliver()` in `packages/worker/src/deliver/deliver.ts` is the only merge path. Its gate logic is carried over unchanged and runs as a leased `deliver` turn, one per project at a time. Its one change: `approvals` becomes a function so the pre-merge re-validation re-reads platform state.

### 9.9 Failure handling
| Event | Effect | Who continues |
|---|---|---|
| Provider usage limit | Turn deferred; provider limited until reset; its agents show provider-limited; nothing quarantined | automatic at reset, other provider only by rule |
| Cap or budget hit | Deferred | next period or a rule |
| Lease lost, worker crash | Uncertain; scoped quarantine | human |
| Engine crash, exit seen | Failed; task blocked(needs-attention) | PM triage or human |
| Timeout, kill confirmed | Timed out, as failed | PM or human |
| Resume missing before output | Session lost; one requeue in packet mode | automatic, once |
| Delivery lost mid-merge | Entry uncertain; project merge queue frozen | human runs reconcile (view only) |
| Work turn ends without a report | One continuation turn, then blocked(no-report) | automatic once, then PM |
| Bounded turn lost | Item expired; deliberation counts an abstention | never retried |

Ephemeral launched workers cannot keep a session or worktree between turns. They are allowed only with `publishAuthorized`, run every turn in packet mode and push the branch at the end of each turn; otherwise the configuration is refused with that reason.

### 9.10 Trace
`TraceStep {turn, seq, at, kind read|edit|run|think|message, title, detail, status, tool, target, artifact?, duration, tokens}`. `message` steps are emitted by the coordinator when it handles a tool call, so they are identical on every engine. Diffs come from git on the worker, never from tool input: per step against a first-touch baseline, plus a `git status` delta after each `run` step to catch shell edits. Limits: 64 KB per diff, 16 KB inline run output with up to 1 MB as an artifact, 2 KB think text, screenshots uploaded (closing today's gap where `<runDir>/browser` is never archived). A redactor strips worker secret values and token patterns before upload. Engines do not stream a tool's stdout, so "streaming" means the step list plus throttled text deltas.

## 10. Knowledge store
- Pages form a tree by path within a scope (org, team, project, sub-project); sub-projects appear as folders under their project. Revisions are append-only; history and diff are computed from revisions; revert writes a new revision.
- Decision callouts in a page are links to `decisions`, rendered inline, never copied text.
- "Read by N agents today" comes from `kb_reads`, written when `knowledge.read` is called or a page is injected into a packet.
- Memory lifecycle: a memory is filed by an agent or kept by a memory turn, and is in use at once; a person confirming it ranks it higher, and one the owner said outranks the rest. It is replaced by a newer memory (superseded, with the reason, and the replacement can be undone), promoted to a page, taken out of use (no hits in 60 days, or its turns kept being sent back) or retired. Every change appends an event. A memory carries a one-line abstract, its evidence, and optionally the role it is for.
- A memory turn (`remember`, lowest priority, no checkout) follows a finished task, a review that asked for changes, a failed work turn and a settled decision, on the seat that did the work. It reads what happened with the nearest memories and keeps, replaces or retires in one `memory.record` call.
- `recall` in `packages/coordinator/src/knowledge/recall.ts` runs in the claim: the memories of the turn's scopes and roles, ranked by fit to the task (shared rare words) and standing (the owner's word, confirmation, outcome score, use), within a token budget per kind of turn, the top few in full and more as one line, plus pointers to the pages that fit. The given ids are kept in `memory_injections`; a resumed session is not given them twice. A reviewer's verdict moves the score of what the author was given since the last verdict.
- Search is `SearchPort` over pages, memories, messages and issues, filtered by the caller's access. Semantic search goes through `VectorPort` wherever an embedding model can be reached: the one named in `AGENT_TEAM_EMBEDDINGS_URL`, else one found on a model server on the same machine; without one, search is lexical.
- Sync targets are driven from the revision log: a git mirror (one commit per revision, one-way out) and a Drive folder (two-way; an inbound change becomes a revision authored by the sync, and a conflict keeps both with the remote as a sibling revision).

## 11. Tracker and SCM sync
- Trackers are the board of record. `tasks` mirror tracker issues by polling (private deployments cannot receive webhooks); `external_refs` holds the identifier, URL, remote version and the column both sides last agreed on. Whichever side left that column moved: a task the platform moved is written to the tracker (again on the next poll if the tracker refused), and an issue moved in the tracker moves the task. Only when both moved does the remote win for state; it always wins for title and labels. Local-only fields (assignee agent, links, thread) are never overwritten. Every change of a task's state appends a `task.state_changed` event with the state it left, in the same transaction.
- State mapping to the four columns uses the normalized `state.type` the adapters already return (`backlog`, `unstarted`, `started`, `completed`, `canceled`) plus the progress labels of the GitHub Issues adapter. Tracker comments and thread messages mirror both ways with an origin marker to prevent loops.
- The owner-approval flow (`approvalStatus`, `prepareApproved`, cancel on withdrawn approval, ideation cooldown) lives in `packages/coordinator/src/sync/tracker.ts`.
- Agents reach issues through platform tools backed by the tracker adapter, so nothing depends on a vendor's MCP server. `tracker.mcpServers()` is no longer mounted for agents.
- New SCM adapter methods, implemented for GitHub and GitLab and covered by one contract suite with recorded fixtures: `publish`, `reviewState`, `testReports`, `environments`. GitLab returns parsed JUnit from the pipeline test-report API and preview URLs from environments; GitHub downloads the JUnit artifact of the check run and reads deployments.
- This repository is mirrored to GitLab with `.gitlab-ci.yml` running `verify`, so the GitLab path is exercised continuously.
- Slack is an integration adapter: outbound mirror of discussion and issue threads, inbound through Socket Mode using Node's built-in WebSocket.

## 12. Costs, budgets, rules
- One `cost.recorded` event and one `cost_entries` row per turn: agent, provider, billing kind, tokens in, out and cached, amount in minor units and currency. Engines report USD; the org has a display currency and a configured rate, and the rate used is stored with the entry.
- Rollups: `cost_daily` by day, project, agent and provider; sub-projects roll up into their project on read. Subscription and local turns record zero marginal amount while their tokens still count toward window limits.
- Rules are data (`cost_rules`, `routing_rules`): cap per agent per day then fall back to a named provider; route turns by kind and task tags; warn in discussion at a budget percentage; pause agents of paused projects at a window percentage. The scheduler calls one evaluation point, `rules.evaluate(turnDraft, snapshot) -> {allow, route?, deferReason?, notices[]}`.
- CSV export of entries for a period.

## 13. Tests and checks
- JUnit XML is the ingestion format, from `testReports()` on the SCM adapter, from an upload, or from an agent's `test.report`. Non-software teams report domain checks in the same shape, and the page is titled Checks for suites of kind `check`.
- The matrix is the latest `check_runs` per branch and suite. Failing cases carry an owner agent and link to issues through `links`. A failing run on a task's branch emits `check.failed`, which wakes the author.
- Harness health is derived: total cases on the base branch, quarantined flaky cases, wall time per suite, and a change list from `check.harness_changed` events.

## 14. Front end

### 14.1 Shell and routes
Three-pane app shell: sidebar (organization, project tree with progress, team roster with one line of what each agent is doing, links to proposals, costs, integrations, roles), main area with breadcrumb and project tabs, and an optional right rail. Desktop-first at 1440; below 900 px the sidebar becomes a drawer and the rail becomes a tab. Dark theme per the design; tokens make a light theme possible later.

`/login`, `/setup`, `/invite/:token`; `/p/:project[/:sub]/{tasks,issues,issues/:n,product,tests,workload,knowledge[/*path],team}`; `/agents/:id`; `/org`; `/roles[/:slug]`; `/proposals[/:id]`; `/costs`; `/integrations`; `/settings/{members,auth,providers,environments,project/:id}`; `/audit`; `/dev/ui`.

### 14.2 Tokens
`tokens.css` is the Tailwind v4 theme with the default scales cleared. The boards' 21 font sizes, 61 colours and 12 radii collapse to:
- Type roles: `label` 10.5 uppercase, `caption` 11, `small` 12, `body` 13, `title` 16, `heading` 18, `display` 24, `metric` 26 mono. IBM Plex Sans and Mono, self-hosted.
- Colour: four surfaces, two borders, four text levels, accent, and four statuses (working, review, attention, stop) each as solid, tinted background and tinted text, plus a ten-colour agent tint palette.
- Radius: chip 4, control 7, card 10, pill. Spacing on a 4 px grid. Avatar sizes xs 16, sm 24, md 28, lg 36.

### 14.3 Layers and lint
- `ui/`: Text, Button, IconButton, Chip, Avatar, StatusDot, Card, SectionLabel, Segmented, Tabs, Meter, StatTile, ListRow, KeyValue, Field, Textarea, Checkbox, Icon, and the Radix wrappers Menu, Select, Dialog, Popover, Tooltip. The only place typography, colour and radius classes appear.
- `patterns/`: AppShell, Sidebar, PageHeader, RightRail, Thread, Message (note, feedback with stance chip, decision card), Composer with attachments and @mention, TaskCard, AgentLine, EntityLink, MatrixTable, DiffView, TraceRow, EmptyState.
- `features/<screen>/`: compose patterns, fetch data, layout utilities only.
- `scripts/lint-ui.ts` fails on: arbitrary-value classes, inline `style` props, hex colours outside `tokens.css`, and any text, font, background, border-colour or radius class under `features/`.
- `/dev/ui` renders every primitive and pattern with its variants and is the visual reference for people and agents.

### 14.4 Data layer
`data/client.ts` is the typed Hono client. `data/store.ts` is a small normalized store read through `useSyncExternalStore` with selectors. `data/stream.ts` applies SSE events to the store, handles snapshot-then-stream and reconnect. No query library. Optimistic updates only for posting messages and moving cards.

### 14.5 Demo seed
`agent-team demo` starts a coordinator on an in-memory SQLite database seeded with the boards' sample data (Acme, Web shop, Checkout v2, the five agents, issue #118, the cost series, the Nordlys Studio organization as a second seed) and a fake engine that replays scripted turns. It backs UI development before the runtime exists, the Playwright smoke tests, and side-by-side review against the boards.

## 15. Feature specs

| # | Feature | Backed by | Acceptance |
|---|---|---|---|
| 01 | Projects and sub-projects | `projects` tree, `milestones`, derived progress, roster from agents and running turns | Sidebar matches the board; breadcrumb header; an agent's "doing" line updates live from the stream |
| 02 | Task board | `tasks` mirrored from the tracker; columns from 9.1 | A state change in the tracker appears within one poll; moving a card writes to the tracker; cards show key, tag and owner |
| 03 | Team discussion | Discussion thread per sub-project; deliberation messages; attachments | A proposal, its feedback blocks and the decision render as one thread; a user post with a pasted image opens a triage item for the PM |
| 04 | Product view and snapshots | `product_envs` from `environments()`; a snapshot is a worker-side browser capture at a viewport; markers are client coordinates | Choosing an environment and device shows the capture; marker plus description creates an issue with the annotated image; the "raised from product" list shows each issue's outcome |
| 05 | Issue threads | `issues`, thread, `mentions`, `links`, `external_refs` | @agent or @role wakes exactly one reply turn; linked task, PR and page are shown; sync status per system; a Slack reply appears in the thread |
| 06 | Inspect an agent | `turns`, `trace_steps`, artifacts, private `dm` thread | The trace streams; an edit step expands to its diff; Pause, Reassign and Stop follow 9.3; the 1:1 is invisible to agents and other users |
| 07 | Team and hiring | `agents`, `library_agent` and `team_template` documents | Hire from the library, create an agent, save the team as a template, import one; reorder; PM flag |
| 08 | Roles | `role` and `skill` documents, `agent_roles`, effective grant preview | Editing a role versions it; "worn by" is live; the effective permission view shows the ceiling's cap |
| 09 | Providers | `providers`, `provider_state`, `routing_rules` | Per-agent provider and model select, refused when the engine cannot enforce the agent's restrictions; usage and window per provider |
| 10 | Knowledge and memory | section 10 | Scope switch, tree, page with history, memory rail with promote and review-stale, search across pages and memory |
| 11 | Cost center | section 12 | Tiles, 14-day series, by agent, by project with sub-project roll-up, rules toggles, CSV export, budget edit |
| 12 | Integrations and handoffs | `connections`, `handoffs` | Grouped connections with status and mode; a handoff arrives with its context, can be handed to the team or attached to a task; outbound handoffs show pending results |
| 13 | Team proposals | `proposals`, deliberation, `delegation_rules` | Needs-you, auto-applied and history lists; detail with why, what changes, evidence and the team's votes; approve, approve with changes, decline; retro schedule |
| 14 | Tests and checks | section 13 | Branch by suite matrix; failing cases with owner and issue; harness health; the same page as Checks |
| 15 | Workload | `work_items`, running turns, mentions | One lane per agent with now, queued, feedback owed, threads and the defer reason; rebalance suggests and applies queued moves |
| 16 | Non-software teams | Task `kind`, project `kind`, domain checks, team-built tools registered as project tabs that link to a URL the team serves | The Studio seed renders with a custom tab, Checks and its own integrations |
| 17 | Organization and templates | Org team, templates, `seat_loans`, `project_links` | Org map with the direction team, project cards with team, tasks, budget and cross-team links; create a team from a template |

"Needs you" (`/api/needs-you`) is the single queue of what reaches a human: decisions outside the bounds, escalated deliberations, budget alerts, failing checks on a release branch, quarantines, and issues the user raised.

## 16. Hosting and CLI
- Processes: `packages/coordinator/src/main.ts` and `packages/worker/src/main.ts`. `up` starts those two.
- Every hosting adapter is rewritten in TypeScript against one port (4310) and those two entrypoints: `adapters/hosting/local/up.ts`, `fly/entrypoint.ts` and `fly.toml` (one service), `aws/{entrypoint,deploy}.ts`, the control-plane user-data script, the ECS task definition (health check on 4310), `systemd/install.ts` and the unit files. Launch paths come from one `packageRoot()` helper and one exported `ENTRYPOINTS` map, never from `dirname` chains or literals.
- One `configDir()` helper in `packages/protocol/src/paths.ts` is the only place the config directory is derived.
- Coordinator config gains `storage: {kind, url | path}` and `artifacts` (`{kind: 'local', dir}` by default, a folder under the data directory; any other artifacts adapter kind with its options) plus `traceRetentionDays` (30). New CLI commands in `bin/agent-team.ts`: `demo`, `setup-link`, `migrate`, `call` (agent shim).
- Docker images use `node:24-slim`, build the web assets in a build stage and copy `packages/`, `adapters/`, `blueprints/`, `bin/`. The worker image bake installs Node 24.

## 17. Legacy code: what carries over and where it lands

The existing JavaScript (`core/`, `adapters/`, `bin/`, `scripts/`, all `.mjs`) is the behaviour reference, not the structure. Logic worth keeping is re-typed into the TypeScript layout of section 3 together with its tests (as `*.test.ts`); the legacy file is deleted in the same change. `core/`, `roles.json`, `agents/`, `teams/` and `portraits/` do not exist after Phase 1.

| Logic carried over | From (legacy, deleted) | To (TypeScript) |
|---|---|---|
| Cross-platform spawn, PATHEXT, kill tree, shims, open browser | `core/platform` | `packages/worker/src/platform/` |
| Worktree container, ancestor validation, base inspection, sparse exclusions, safe file reads, overlays, `runChild` | `core/runner` | `packages/worker/src/worktree/`, `turn/process.ts` |
| Merge gate (`deliver`, approval and change validation) | `core/delivery` | `packages/worker/src/deliver/deliver.ts` |
| HTTP client, heartbeat loop, stream tailing, archive and diff | `core/worker` | `packages/worker/src/{heartbeat,turn/stream,trace/artifacts}.ts` |
| Manifest normalization, override allowlist | `core/manifest` | `packages/protocol/src/manifest.ts` (as Zod schemas) |
| Machine-token HMAC derivation, bind validation | `core/queue` | `packages/coordinator/src/auth/machine.ts`, `server.ts` |
| Owner-approval and ideation cooldown rules | `core/intake` | `packages/coordinator/src/sync/tracker.ts` |
| Guided setup, preflight, deployment file | `core/setup`, `core/preflight`, `core/deployment` | `bin/` and `adapters/hosting/shared/` |
| Tracker clients, SCM adapters, artifacts, launcher, integration adapters | `adapters/*` | same paths, `.ts`, each with `contract.ts` |
| Engine env scrubbing, auth checks, limit detection, stream parsing | `adapters/engine/*` | `adapters/engine/*.ts` behind contract v2 (`parse`, `environment`, `preflight`) |
| Provider-neutrality lint | `scripts/lint-neutral` | `scripts/lint-neutral.ts` |

Not carried over: the queue schema and routes, the server-rendered dashboard and settings form rendering, the git-backed memory, the resident PM, chat and intake processes, evidence step parsing and handoff attribution, team documents and `roles.json`, the coordinator prompt, the result file, the `team` and `memory` CLIs, portraits, `scripts/check-syntax`.

## 18. Phases

Each phase ends with a working system. The current release keeps serving the dogfooding project until Phase 1 cuts over.

| Phase | Scope | Exit |
|---|---|---|
| 0 Foundation | Node 24 everywhere; workspaces, strict TypeScript config, lints, both CI files; `protocol`; storage contract, SQLite adapter, migrations, contract suite; event log and SSE; auth, RBAC, setup link; merged Hono server; hosting on one port; web shell, tokens, `ui/`, `patterns/`, gallery; demo seed | `agent-team demo` shows the shell on seeded data; the owner reviews `/dev/ui` before any screen is built |
| 1 Parity cutover | Ported worktree, delivery and platform code; turns, leases and the new worker with one legacy agent per task (`legacySubagents`), one writer per project; MCP with the four legacy capabilities; tracker mirror and task board; discussion; knowledge store and assemble; basic costs; Inspect trace; project settings; Postgres contract job in CI | Dogfooding runs on the new system with today's behaviour and safety; `core/` and every other `.mjs` file deleted, the repository is TypeScript only |
| 2 Seats | Per-agent sessions, providers and models; task state machine; review worktrees; platform-recorded approvals; merge queue; deterministic publish; triage and reply turns replace the PM and chat processes; Team and Providers pages; 1:1, pause, stop, reassign | Multi-agent delivery, still one writer per project |
| 3 Scheduler | Priorities, aging, fairness; provider limit pause; budgets, rules, routing; idle and rebalance; more than one writer per project; Cost center and Workload pages | Parallel work with spend control |
| 4 Deliberation | Deliberation machine, mentions and governor, decisions, issue threads, needs-you queue, Slack mirror | The thread UI is live |
| 5 Self-improvement | Roles, skills, graded permissions, ceiling v3 and diff gate; proposals, delegation, retro; library, templates, Org page, seat loans | Proposals apply inside bounds and reach the owner outside them |
| 6 Surfaces | Product view and snapshots; checks ingestion with `testReports` and `environments` on both SCM adapters; Integrations and handoffs; knowledge sync targets; semantic search | All 17 screens on real data |
| 7 Breadth | Remaining engines at contract v2; OpenRouter, local and Ollama providers; Postgres adapter production-ready; non-software task kinds and team-built tabs | Provider-agnostic and storage-agnostic |

## 19. Verification
- `npm run check`: `tsc --noEmit`, Biome, `lint-neutral`, `lint-ui`, `lint-sql`.
- `npm test` on Node 24, all tests `*.test.ts`: `node:test`, temporary git repositories, in-memory or temporary databases, real HTTP on port 0, synthetic processes, no paid model calls.
  - Storage contract suite against SQLite always and Postgres when `AGENT_TEAM_TEST_PG_URL` is set.
  - RBAC matrix test generated from the table in section 8; API contract tests generated from the Zod schemas.
  - Event log ordering, idempotency and SSE resume.
  - Scheduler simulation on a virtual clock, plus a seeded long run (`npm run test:sim`) asserting the invariants of 9.2 and that every task ends terminal or explicitly quarantined.
  - Deliberation reducer tables: selection, quorum, single revision, dissent coverage, skip rules, escalation, abstention.
  - MCP: scoping, frozen grants, expired lease, idempotent replay, rate limits, every call in the log.
  - Worker: lease loss kills the tree, timeout escalation, orphan sweep, diff artifacts, write-scope gate, redactor.
  - Engine adapter contract suite with a fake engine and recorded stream fixtures; SCM and tracker contract suites with recorded fixtures for both hosts.
  - Ported delivery tests plus approval mapping, staleness, merge queue and frozen queue.
- Web: Vitest and Testing Library for `ui/` and `patterns/`; Playwright smoke over `agent-team demo` covering sign-in, each of the 17 screens, posting to discussion, raising a snapshot issue and approving a proposal, with screenshots compared to the boards by eye at review.
- End to end before each phase exit: `agent-team up` on this repository from a clean config directory, complete `/setup`, run one task through to a merged change on a scratch branch with publishing authorized, on both a GitHub and a GitLab remote.

## 20. Risks and open questions
1. Type stripping with workspace links on Windows and the `prepack` build are checked first in Phase 0; the fallback is relative imports between packages.
2. The Kysely driver for `node:sqlite` needs statement column metadata to tell reads from writes; verify on Node 24.
3. Session scope is (agent, task). One transcript per agent is possible later (`agent_sessions.task_id` is nullable) at higher token cost.
4. Strict same-sha approvals mean a moved base forces a re-review. Carrying approvals across a clean rebase would weaken an owner rule and is left out.
5. Zero-tool feedback depends on packet quality; measure abstention and low-confidence rates before tuning budgets.
6. Shell edits bypass engine write rules, so the diff gate and the environment allowlist (including git credential helpers on workers) carry the enforcement.
7. Sessions and worktrees live on one worker's disk; losing a worker strands its tasks until a human reassigns them. The Team and Workload pages must show this.
8. Resume, MCP-config and sandbox flags of three of the four engines are from vendor documentation and unverified on this machine.
9. Product view captures are screenshots, not a live embedded app; cross-origin framing is not relied on.
10. Multi-writer coordinators are out of scope; the Postgres adapter still assumes one coordinator process appending events.
