# Platform status

[SPEC.md](SPEC.md) is the design. This page says what of it runs, how far each part has been proven, and what is still open. Statuses are about this repository's code: nothing is proven at scale until a pilot has run it on a real project.

## What runs

| Area | State |
| --- | --- |
| Storage adapter, migrations, event log and live stream | Built; contract suite runs on SQLite. The Postgres adapter is written to the same contract and has never been run against a database |
| Accounts, roles, invitations, audit trail, OpenID Connect | Built; OpenID Connect is tested against a local fake identity provider only |
| Turns, leases, scoped quarantine, daily caps, provider concurrency | Built and tested on a fake engine |
| Structured deliberation, reviews, approvals, merge queue, publish and the merge gate | Built; the gate is tested on synthetic repositories and recorded host responses for both source hosts |
| Roles, graded permissions, committed ceiling, write-scope gate | Built and tested |
| Team proposals, delegation bounds, weekly retro | Built and tested |
| Knowledge pages, memories, search, optional semantic search, git mirror | Built; semantic search is tested with a toy embedder |
| Document-folder sync | One way, outbound, against a fake API. Inbound changes are not built |
| Chat mirror, outbound and inbound | Built against fakes; never run against the real service |
| Tracker sync (two trackers), issues, attachments, product environments and marked-up snapshots | Built. Snapshots are pasted images; the worker does not capture pages itself |
| Checks ingestion and the branch-by-suite matrix | Built |
| Costs, budgets, CSV export | Built |
| Web app: every screen in the design, token-driven, with a component gallery | Built; Playwright smoke tests click through every screen on the demo |
| Hosting: local, systemd, Fly, AWS | Local is used daily by the tests and `up`. The Fly and AWS entrypoints boot locally; neither has been deployed from this code. The AWS deploy plan is tested against a fake account |
| Engine adapters | See below |

## The one real turn

On 2026-09-19 one read-only reply turn ran against the installed Claude Code CLI (2.1.233) through `scripts/pilot-turn.ts`, in a throwaway repository with an in-memory database. It completed: the adapter's flags were accepted (including the system prompt file), the stream was parsed into steps, usage and cost, and the agent posted its reply to the discussion through the platform tool endpoint with its per-turn token. It found three defects, now fixed and tested:

- On Windows the CLI is a `.cmd` launcher that Node cannot start directly. The worker now resolves launchers and stops whole process trees (`packages/worker/src/platform.ts`).
- An engine that could not be started crashed the worker. It is now a failed turn with a known state.
- Input tokens left out what arrived through the cache, so a turn reported a handful of tokens.

The other three engine adapters are written from vendor documentation and pass the contract suite on recorded events; none has been run. A write turn, a resumed session and a delivery have not been run against a real model.

## Open

- A pilot on a real project: a write turn through to a merged change, on both source hosts.
- Postgres (and Supabase) against a real database; the CI job for it needs a service container.
- Real credentials for chat, the document folder and an identity provider.
- Deploying Fly and AWS from this code. The launched-worker path writes no worker configuration onto a new host yet, and the deploy library is not wired into the CLI.
- Inbound document-folder sync and worker-side page captures for the product view.
- Voice mode and portraits were dropped on purpose (section 1 of the spec).
