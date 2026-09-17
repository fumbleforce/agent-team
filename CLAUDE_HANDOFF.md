# Continue the shared agent-team setup

## Immediate goal

The owner has approximately 2% OpenCode/OpenAI usage remaining and wants to use their Claude subscription. Claude Code 2.1.270 is installed at `/home/jorgen/.local/bin/claude`. `claude auth status` confirmed a logged-in claude.ai **Max** subscription. Use the official Claude Code CLI with that login; do not extract OAuth credentials or route them through OpenCode.

The worker service has been stopped to avoid further model consumption. The coordinator remains available. No new ideation or development job was started in this unfinished phase.

## Existing system

- Shared private repo: https://github.com/fumbleforce/agent-team, checkout `/home/jorgen/repo/agent-team`.
- Myntbase: https://github.com/fumbleforce/stockapp, checkout `/home/jorgen/repo/stockapp`.
- x3d is the approved host; existing Tailscale route proxies OpenCode on localhost:4096. Preserve it.
- Coordinator API: localhost:4310, SQLite-backed queue. Private configs/environment are under `~/.config/agent-team/`; never print credentials.
- systemd user services: `agent-team-coordinator` and `agent-team-worker`. No timers enabled.
- Owner-approved delivery: developer -> tester -> one reviewer -> PM spec/product-value approval -> passing configured CI -> deterministic auto-merge. All approvals must identify the same commit. Myntbase's existing merge-triggered Fly deployment is approved.
- Private GitHub plan lacks branch protection. Owner explicitly approved `delivery.checkEnforcement: "runner"`; never silently fall back from GitHub-required enforcement.
- Earlier end-to-end pilot passed and merged https://github.com/fumbleforce/stockapp/pull/14. FUM-6, FUM-8, FUM-12 are Done.

## Current user request

Add a shared ideation agent that proposes substantial, attractive features/improvements rather than inventing pixel-polish work. Owner decisions:

- Ideas live in **Linear**; the owner approves/rejects by moving cards between workflow states.
- **10 unfinished ideas per project**, including proposed, approved and active ideas. Done/Canceled free capacity.
- Backlog = proposal, Todo = approved, Canceled = rejected.
- Start initial ideation and current actionable work; after that wait for approved ideas. Existing actionable Myntbase work is FUM-5 (upload resolver stale responses). FUM-7/FUM-9 remain planning/decision backlog, not automatically approved.
- Major decisions go to the owner. Brief implementation notes; code comments explain intent, docs describe current behavior. Shared preferences are in OWNER_PREFERENCES.md.

## Uncommitted implementation

Inspect `git status` before editing. Current changes in the shared repo:

- `idea-schema.mjs`: validates capped ideation configuration and proposal schema.
- `linear-api.mjs` + tests: deterministic GraphQL API, workspace checks, paginated backlog, cap/deduplication, proposal publication and approval checks.
- `linear-intake.mjs` + tests: no-model polling, approved ideas -> jobs, withdrawn queued approvals -> cancel, bounded ideation refill.
- `queue.mjs`, `worker.mjs`, `runner.mjs`, `cli.mjs` and their tests: ideation jobs/reports, proposal limits, queued cancellation, pre-model API approval/cap checks, credential stripping.

The intended manifest `ideation` shape is:

```json
{"enabled":true,"backlogCap":10,"batchSize":3,"minimumIntervalHours":24,"ideaLabel":"Idea","proposedState":"Backlog","approvedState":"Todo","rejectedState":"Canceled"}
```

Three proposals per batch and a 24-hour cooldown are proposed conservative defaults, not separately chosen by the owner. No ideation schedule is activated. The direct Linear API needs a workspace-scoped LINEAR_API_KEY. It has not been supplied or configured; the existing OpenCode MCP connection is a different integration. Never ask the owner to paste a key into chat.

Last component verification: Linear API/intake tests 18 passed; existing suite after runner/worker changes 132 passed. The full new suite is not yet wired into package.json or independently reviewed. No new changes have been committed/published.

## Remaining work

1. Add a reusable execution-engine adapter: existing OpenCode engine and official Claude Code CLI engine using the already authenticated Max subscription. Preserve per-project roles/instructions, structured reports, isolated worktrees, cancellation, and delivery gates. Do not use an API key or third-party subscription-token proxy. Subscription limits still apply; handle rate limits without retry loops or paid API fallback. Inspect `claude --help` and current headless docs before implementing flags. Ensure API-key/auth-token environment overrides cannot accidentally select API billing for subscription workers.
2. Finish ideation integration: shared `team-ideation` role/config, plugin tests (currently expect seven roles), package scripts, project settings/docs, and PM/coordinator rules restricting work to approved goals. Ideation must not implement code, self-approve ideas or move them to Todo. Initial generation can use the current interactive Linear connection if available; don't claim autonomous polling is live without API credentials.
3. Fix known integration mismatch: `linear-intake.mjs` currently sends `publish:false` and `autoMerge:false` on ideation jobs. The queue's strict ideation contract forbids those fields entirely; omit them.
4. Review `approvalStatus`: it should reject `agent:blocked`/`owner:decision` labels as well as blocking relations. Allow withdrawn queued approvals to be reapproved later without permanent suppression by canceled/no-model job history. Add regression tests.
5. Build the local concealed Linear-key setup command, validate workspace/schema before activation, install an intake service and a worker environment drop-in. A delegated `configure-linear.mjs` task was interrupted before it produced files. Do not assume that command exists. Keep the key out of model subprocesses and logs. No new model polling loops.
6. Check that automatic jobs use a fresh remote base without touching the owner's dirty primary checkout. Current runner defaults to local HEAD and never fetches; the primary checkout is behind the pilot merge and contains substantial unrelated user changes. Do not pull/reset over those changes.
7. Run all relevant synthetic tests and obtain independent code-review/PM acceptance. Publishing authority for this ongoing setup came from the owner's earlier explicit authorization; stage exact intended files only. Do not include the primary checkout's unrelated changes.
8. Start the initial proposals and explicitly authorized current work with bounded execution, then leave the team idle until approvals. Do not silently activate unrelated backlog or unrestricted schedules. Report actual service/job/PR outcomes and any API-key blocker clearly.

## Boundaries

Read AGENTS.md in each repo. Myntbase's `.cursorrules` forbids full E2E runs and protects real databases. The runner uses sibling worktrees and sparse exclusions for tracked `.env`/database backups. Never materialize those artifacts or reuse primary node_modules. Shared role agents do not merge themselves; deterministic delivery handles authorized merges. Do not change the existing OpenCode server service or Tailscale routes while the owner is connected.
