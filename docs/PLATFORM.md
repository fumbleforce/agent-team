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
| Checks ingestion, the branch-by-suite matrix and harness health | Built. Harness health is derived on read from the base branch: total cases, cases quarantined as flaky (a skipped JUnit case whose reason says quarantined or flaky, or the `quarantined` list of `test.report`), wall time per suite, and a change list from `check.harness_changed` events |
| Costs, budgets, CSV export | Built. Engines report US dollars; the organization sets its display currency and what one dollar is worth in it on the Costs page. Each entry keeps the dollar amount and the rate it was converted at, so a new rate applies from then on; a new currency restates the daily rollups from the entries, and budgets keep the numbers that were typed. Subscription and local turns record a zero amount and their tokens |
| Web app: every screen in the design, token-driven, with a component gallery | Built; Playwright tests click through every screen on the demo, create a project, walk the guided setup of an integration, use the command palette and the narrow-screen drawer. Primitives and patterns have Vitest tests |
| Setting things up in the app | A project is created from the sidebar. Integrations are connected through a catalog of what the adapters support (`adapters/integration/catalog.ts`): each entry has its own steps, fields, credential check and, where the coordinator holds the credential, a live connection test. Secrets are never entered in the app. No connection test has run against a real account |
| Hosting: local, systemd, Fly, AWS | Local is used daily by the tests and `up`. The Fly and AWS entrypoints boot locally; neither has been deployed from this code. The AWS deploy plan and its CLI (`deploy aws`, plan by default, `--apply` to change anything) are tested against a fake account. Disposable workers are started by the coordinator when work waits and no worker serves the project; the launched host reads its token from the parameter store, never from user data. The Fly configuration passes `fly config validate` |
| Engine adapters | See below |

## The one real turn

On 2026-09-19 one read-only reply turn ran against the installed Claude Code CLI (2.1.233) through `scripts/pilot-turn.ts`, in a throwaway repository with an in-memory database. It completed: the adapter's flags were accepted (including the system prompt file), the stream was parsed into steps, usage and cost, and the agent posted its reply to the discussion through the platform tool endpoint with its per-turn token. It found three defects, now fixed and tested:

- On Windows the CLI is a `.cmd` launcher that Node cannot start directly. The worker now resolves launchers and stops whole process trees (`packages/worker/src/platform.ts`).
- An engine that could not be started crashed the worker. It is now a failed turn with a known state.
- Input tokens left out what arrived through the cache, so a turn reported a handful of tokens.

The other three engine adapters are written from vendor documentation and pass the contract suite on recorded events; none has been run.

## Deviations from the spec

- **Typed API client (sections 7 and 14.4).** The spec names Hono's `hc<AppType>` client. That client infers routes only from an app built as one chained expression. The coordinator registers its routes, more than a hundred of them, as separate `app.get(...)` statements across five files, so `AppType` carries no routes, and adopting the client would mean rewriting every route file for a type-level gain. Instead the responses of the most used resources (project view with its board, thread messages, costs summary, team, and harness health) are Zod schemas in `packages/protocol/src/views.ts`. The coordinator builds those responses against the inferred types (`satisfies`, or the return type of the function that builds them), the web app imports the same types through `packages/web/src/data/client.ts` instead of writing interfaces, and route tests parse real responses with the schemas. Other screens still declare their response shapes locally; they move to `views.ts` as they are touched.
- **Publishing (sections 1 and 16).** The root package is what gets published; the workspace packages are not published on their own. `prepack` builds the web app and runs `scripts/build-dist.ts`: `tsc -p tsconfig.build.json` emits every server source to `dist/`, mirroring the repository; the `@agent-team/*` specifiers in the emitted files are rewritten to relative paths inside `dist/`; and the blueprints, the built web app and the hosting templates are copied in, so `dist/` is a complete root for `packageRoot()`. `bin` points at `dist/bin/agent-team.js` only inside the tarball (`postpack` points it back), so a checkout keeps running `bin/agent-team.ts`. `npm run test:pack` packs, installs the tarball into an empty project and runs the usage, `migrate` and `demo` from `node_modules`. The package is still marked `private`; removing that is the owner's call.

## Real runs on a real engine and a real code host

On 2026-09-19, with Claude Code 2.1.233 and a private scratch repository on GitHub (`scripts/pilot-work.ts`, `scripts/pilot-delivery.ts`; both spend model usage and are never part of the test suite):

- A work turn wrote code in its task's worktree with the secret file excluded, its diffs came from git, it reported through the platform tool and committed on the task's branch. A second turn on the same task resumed the same engine session and acted on the changed brief.
- A full delivery: the branch was pushed and a draft pull request opened; tester, reviewer and PM each reviewed in their own detached checkout of that commit (the tester ran the tests) and recorded a verdict; the gate marked the draft ready, waited for the required check, merged it and confirmed the merge commit.

What these runs found and fixed: sessions never resumed, because rotation used a turn's cumulative input tokens instead of the size of the conversation; a resumed session was not told that the task's brief changed or what people wrote on it; reviewers could not record a verdict, because the tool demanded a commit id that a read-only session cannot look up, and could not run tests at all; nothing ever took an approved change out of draft, so the gate always refused it.

## Checked against the real services, read-only

Run on 2026-09-19 with `node scripts/real-check.ts <owner/name>` (uses `GH_TOKEN`) and `node scripts/real-check-sso.ts` (no credentials). Nothing is written anywhere by either.

- GitHub: the guided setup's connection test reached a real repository; the tracker read its issues (pull requests excluded) and an issue's comments; environments and test reports answered without error. Writes ran against a private scratch repository (`scripts/real-check-writes.ts`): an issue was created, commented on, moved through the board's states and closed, and read back.
- Single sign-on: the address the guided setup derives for Google Workspace, and for Microsoft Entra ID from a tenant ID, answers as an OpenID service that names the same issuer. A full sign-in with a registered app has not been done.

The wording of every guided setup (integrations, model providers, single sign-on) was checked against each vendor's official documentation on 2026-09-19 and corrected. Known limits that came out of it: the hosted HubSpot tool server signs in with OAuth and its tokens expire, and nothing here refreshes them yet; a fine-grained GitHub token cannot read check results on a private repository, so the GitHub CLI login or a classic token is what the merge gate needs there.

## Open

- The same real delivery on GitLab, and a pilot on a real project rather than a scratch one.
- A hosted Postgres (Supabase). Everything is ready for it: set `AGENT_TEAM_TEST_PG_URL` to a direct connection string and run `AGENT_TEAM_TEST_STORAGE=postgres npm run test:postgres`; every test then lives in a schema of its own on that server and drops it afterwards. A deployment can likewise be kept in a named schema with `storage: { kind: 'postgres', url, schema }`.
- Real credentials for chat, the document folder and an identity provider.
- Deploying Fly and AWS from this code: both create billable resources and need the owner's go-ahead. The launched host's boot script has only been syntax-checked.
- The three other engine CLIs are not installed on this machine, so their adapters remain unrun.
- Voice mode and portraits were dropped on purpose (section 1 of the spec).
