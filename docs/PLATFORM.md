# Platform status

[SPEC.md](SPEC.md) is the design. This page says what of it runs, how far each part has been proven, and what is still open. Statuses are about this repository's code: nothing is proven at scale until a pilot has run it on a real project.

## What runs

| Area | State |
| --- | --- |
| Storage adapter, migrations, event log and live stream | Built. The contract suite and the whole package test suite run on both adapters: SQLite, and the Postgres adapter against an in-process Postgres (`npm run test:postgres`, also in CI). A hosted Postgres such as Supabase has not been tried; set `AGENT_TEAM_TEST_PG_URL` to point the contract suite at one |
| Accounts, roles, invitations, audit trail, OpenID Connect | Built, with login lockout, named revocable machine tokens, trusted-header sign-in on a loopback bind only, `Idempotency-Key` and `If-Match`, and audit, members, sign-in and project settings pages. OpenID Connect is tested against a local fake identity provider only |
| Turns, leases, scoped quarantine, daily caps, provider concurrency | Built and tested on a fake engine. The scheduler is a set of pure functions (priority classes with aging, typed reasons for every refusal, budgets, cost and routing rules, provider limits that lift on their own, rebalance of queued work), checked by table tests and a seeded long simulation (`npm run test:sim`) |
| Engine sessions and trace | One session per agent and task, resumed with a delta of what changed, rebuilt once from a deterministic packet when the engine lost it; a work turn that ends without a report gets one continuation. Diffs come from git on the worker, secrets are redacted before upload, orphaned engine processes are swept at worker start. Tested on the fake engine |
| Agents' tools | All tools of section 9.6, with mentions (one reply, depth two, two wakes an hour, overflow to triage), idempotent replays and per-turn rate limits |
| Structured deliberation, reviews, approvals, merge queue, publish and the merge gate | Built; the gate is tested on synthetic repositories and recorded host responses for both source hosts |
| Roles, graded permissions, committed ceiling, write-scope gate | Built and tested |
| Team proposals, delegation bounds, weekly retro | Built and tested |
| Knowledge pages, memories, search, optional semantic search, git mirror | Built; semantic search is tested with a toy embedder |
| Document-folder sync | Two-way against a fake API: an inbound edit becomes a revision authored by the sync, a conflict keeps the local text current and the remote as a sibling revision. Never run against the real service |
| Chat mirror, outbound and inbound | Built against fakes; never run against the real service |
| Tracker sync (two trackers), issues, attachments, product environments and marked-up snapshots | Built. A snapshot is captured by a worker driving a locally installed browser from its command line (one real capture of the demo succeeded on this machine), or pasted |
| Checks ingestion and the branch-by-suite matrix | Built |
| Costs, budgets, CSV export | Built |
| Web app: every screen in the design, token-driven, with a component gallery | Built; Playwright tests click through every screen on the demo, create a project, walk the guided setup of an integration, use the command palette and the narrow-screen drawer. Primitives and patterns have Vitest tests |
| Setting things up in the app | A project is created from the sidebar. Integrations are connected through a catalog of what the adapters support (`adapters/integration/catalog.ts`): each entry has its own steps, fields, credential check and, where the coordinator holds the credential, a live connection test. Secrets are never entered in the app. No connection test has run against a real account |
| Hosting: local, systemd, Fly, AWS | Local is used daily by the tests and `up`. The Fly and AWS entrypoints boot locally; neither has been deployed from this code. The AWS deploy plan and its CLI (`deploy aws`, plan by default, `--apply` to change anything) are tested against a fake account. Disposable workers are started by the coordinator when work waits and no worker serves the project; the launched host reads its token from the parameter store, never from user data. The Fly configuration passes `fly config validate` |
| Engine adapters | See below |

## The one real turn

On 2026-09-19 one read-only reply turn ran against the installed Claude Code CLI (2.1.233) through `scripts/pilot-turn.ts`, in a throwaway repository with an in-memory database. It completed: the adapter's flags were accepted (including the system prompt file), the stream was parsed into steps, usage and cost, and the agent posted its reply to the discussion through the platform tool endpoint with its per-turn token. It found three defects, now fixed and tested:

- On Windows the CLI is a `.cmd` launcher that Node cannot start directly. The worker now resolves launchers and stops whole process trees (`packages/worker/src/platform.ts`).
- An engine that could not be started crashed the worker. It is now a failed turn with a known state.
- Input tokens left out what arrived through the cache, so a turn reported a handful of tokens.

The other three engine adapters are written from vendor documentation and pass the contract suite on recorded events; none has been run. A write turn, a resumed session and a delivery have not been run against a real model.

## Open

- A pilot on a real project: a write turn through to a merged change, on both source hosts.
- A hosted Postgres (Supabase) with a real connection string.
- Real credentials for chat, the document folder and an identity provider.
- Deploying Fly and AWS from this code: both create billable resources and need the owner's go-ahead. The launched host's boot script has only been syntax-checked.
- The three other engine CLIs are not installed on this machine, so their adapters remain unrun.
- Voice mode and portraits were dropped on purpose (section 1 of the spec).
