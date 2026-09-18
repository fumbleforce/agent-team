# Agent Team

Reusable delivery teams for multiple repositories, executed by either the OpenCode CLI or the official Claude Code CLI. One copy of the roles and runner serves every project; each project supplies only its own product goals, engineering instructions and Linear routing.

Status: working initial implementation with synthetic automated tests. Real model/Linear/GitHub delivery and Tailscale service deployment require an integration pilot. No service is enabled merely by checking out this package.

## Architecture

```text
Laptop / phone / workstation
          | Tailscale private network
          v
One coordinator API + local SQLite job database
          | atomic job claims, leases, heartbeat, results
          +---------------------+
          v                     v
Worker on host A          Worker on host B
Project A, Project B      Project C, Project D
          |                     |
   disposable worktrees    disposable worktrees
          |                     |
   coordinator -> PM -> UX -> developer -> tester -> reviewer
   (OpenCode or Claude Code engine per worker/job)
          |                     |
       Linear evidence + optional GitHub PRs
```

Different projects can execute concurrently (configurable worker concurrency). One job per project executes at a time across workers. Role sessions are independent but writers within a job are sequenced. Parallel developers within one project are deliberately not implemented yet; that needs issue-level dependency/conflict management and an integration queue.

### What synchronizes what

| Data | System of record / transport |
| --- | --- |
| Shared roles and runner versions | This Git repository, pinned to the same revision on workers |
| Project source, charter and instructions | Each project's Git repository |
| Product backlog and review evidence | Linear, scoped by workspace/team/project IDs |
| Job ownership, execution status, leases | One coordinator API and its SQLite database |
| Source changes delivered between hosts | Git branches/PRs, when publishing is authorized |
| Detailed logs and uncommitted changes | Worker-local run directories; access the worker over Tailscale/SSH |
| Network connectivity | Tailscale; it does not synchronize files, Git, credentials or execution state |

Do not copy a live SQLite database or synchronize active Git worktrees with Syncthing/Dropbox. Back up coordinator state using SQLite's online backup facilities or with the coordinator stopped, including consistent WAL state. Workers contact the one coordinator over HTTP(S); they do not open its DB remotely.

## Why these tools

- **OpenCode CLI:** supports named agents, independent subagents, structured run output and headless execution. A thin CLI adapter avoids introducing another agent framework.
- **Claude Code CLI:** the official `claude` binary runs the same roles headlessly on the worker's logged-in claude.ai subscription: appended system prompt for the coordinator, `--agents` for role subagents, stream-json evidence, Linear as its only MCP server. No API key, token extraction or proxy is involved; see Execution engines.
- **Linear:** product planning and human-visible workflow. It is not the execution lock; check-then-update issue status is not an atomic distributed claim.
- **Git/GitHub CLI:** reproducible bases, worktree isolation and optional PR delivery. Worktrees are not security sandboxes. Dedicated worker accounts/containers are the next isolation layer.
- **SQLite on one coordinator:** transactional claims and durable state without provisioning another service. Node 22.21.1+ includes the experimental `node:sqlite` API used here. Multiple workers/projects do not require multiple database writers on different hosts.
- **Tailscale:** private access to the coordinator and worker evidence. Use existing tailnet ACLs to limit access; the API also requires a bearer token. Keep the coordinator on loopback behind Tailscale Serve HTTPS, or bind explicitly to its Tailscale IPv4 address.
- **systemd user services/timers:** startup, restart and regular queue triggers on an always-on Linux host. GitHub Actions remains the independent PR validation lane, not an indefinite interactive worker.

We do not yet need Redis, Kubernetes, Temporal or a second agent framework. Revisit PostgreSQL/Temporal when requiring coordinator high availability, rich resumable workflows, hundreds of jobs, or event-driven retry policies. Replace the queue persistence/orchestration layer then rather than copying per-project runners.

## Prerequisites

- Linux workers with Node >=22.21.1, Git and the chosen engine: OpenCode with its provider login, or Claude Code (`claude auth status` must report a claude.ai login). Authenticate Linear for that engine on each worker.
- GitHub CLI (`gh auth login`) and Git push access only for jobs explicitly submitted with publishing enabled.
- Per-project toolchains and synthetic test data. Dependency installation happens in the worktree, not the user's normal checkout.
- A machine that stays awake. A sleeping laptop cannot execute jobs; another online worker can claim new jobs, but uncertain expired jobs remain quarantined.

There are no npm runtime dependencies. Run `npm test` and `npm run check` to validate the toolkit.

## Add any project

1. Add `.agent-team.json` based on `project.example.json` to that repository.
2. Write its charter and engineering instructions; specify their relative paths in the manifest. Do not copy role files or runner code.
3. Add `.agent-team/` and `.agent-team-result.json` to its `.gitignore`.
4. Create the scoped Linear project and the `agent:ready`/`agent:blocked` labels. The current adapter expects Todo, In Progress and In Review states; other workflows require an adapter/configuration extension.
5. Register a project key in coordinator configuration, and map that key to a local checkout in each eligible worker's config. Local paths can differ per machine.
6. Verify the actual Linear workspace identity before writes. Separate workspaces currently require separately authenticated OpenCode worker profiles/accounts; do not swap one shared OAuth connection while jobs are running.

The `repository` field in coordinator configuration is registry metadata, not automatic cloning or remote verification. Provision the intended clone yourself. Run code must be trusted: project instructions, scripts and OpenCode plugins execute under the worker's account.

## One local cycle

```sh
node core/runner.mjs --project /path/to/project --dry-run
node core/runner.mjs --project /path/to/project --execute --issue TEAM-123
node core/runner.mjs --project /path/to/project --status
```

Use `--engine claude` to run on Claude Code, `--model` for an engine model identifier, `--timeout-minutes 45`, and optionally `--base origin/main`. Bases are local refs unless `--fetch` is given with a `REMOTE/BRANCH` base: the runner then fetches only that remote-tracking ref before resolving it, leaving the primary working tree, index and HEAD untouched. Dry-run never fetches. For repeatable cross-machine jobs, enqueue an immutable commit SHA available on every worker. The default HEAD may differ between machines.

The runner overlays only manifest/charter/instruction files from the configured checkout, supporting initial uncommitted setup. Ordinary uncommitted application changes, node_modules, databases and local secrets are not copied. Before initial checkout, tracked filenames are inspected and known environment, database/sidecar and private-key filenames are excluded using sparse checkout. Examples/templates remain available. Dry-run and journals list excluded paths without reading contents. Unrecognized committed secrets can still be present: this is not a secret scanner or OS sandbox. Common inherited database/profile environment overrides are filtered.

Shared agent prompts are loaded once from this toolkit and injected into the child OpenCode configuration. Existing global/project OpenCode settings still merge; inspect them before sustained unattended use. The runner does not modify global config or require copied agents. To inspect roles interactively:

```sh
OPENCODE_CONFIG=/absolute/path/to/agent-team/roles.json opencode debug agent team-coordinator
```

To use shared roles in a new interactive OpenCode instance, launch with that same `OPENCODE_CONFIG` variable from a configured project. Restart OpenCode after config/role changes; existing instances do not reload them.

Alternatively, register the shared plugin once in global OpenCode configuration:

```json
{ "plugin": ["file:///absolute/path/to/agent-team/opencode-plugin.mjs"] }
```

It loads the same role definitions and owner preferences for every project, adds `/team` as the owner-facing command, and preserves explicit user agent overrides and the existing MCP/default-agent settings. The local x3d installation now has this reference; restart its OpenCode server to load it. Other machines install one reference to their own toolkit checkout, not copies of the role files.

## Execution engines

`--engine opencode` (default) runs `opencode run --agent team-coordinator` with the shared roles injected through `OPENCODE_CONFIG_CONTENT`. `--engine claude` runs `claude --print` in the same isolated worktree with identical prompts, reports, cancellation, timeouts and delivery gates:

- Preflight runs `claude --version` and `claude auth status`; the run fails before any model call unless the status reports a logged-in first-party claude.ai account. Journals record only the auth method and subscription type.
- The child environment drops `ANTHROPIC_*`, `CLAUDE_CODE_*` and nested-session variables in addition to the usual filters, so an inherited API key, auth token, base URL or Bedrock/Vertex switch cannot select API billing. `--bare`, `--max-budget-usd` and `--fallback-model` are never used.
- Owner preferences, the coordinator role and the project's charter/instruction files form an appended system prompt (`system-prompt.md` in the run directory). Shared subagent roles become `--agents`; OpenCode edit/bash/task/Linear denials map to `disallowedTools`.
- Permissions: `acceptEdits` with automatic denial of anything that would prompt, `Bash` and the `linear` MCP server allowed, and prefix deny rules for `git push --force`/`-f`, `git reset --hard`, `gh pr merge` and deploy/live-test/db-reset scripts. These are prefix rules, not a sandbox: rearranged commands are not caught, and the delivery helper remains the merge gate. Only user settings load (`--setting-sources user`), so the worker account's own hooks, permission rules and `env` still apply; project settings from the target repository and every MCP server except `linear` are excluded (`--strict-mcp-config`). Built-in Claude subagent types stay available to the Agent tool; the coordinator is instructed to use only the shared role agents, and approvals are attested by agent identifiers, not enforced by tooling. Sessions are not persisted; `events.jsonl` holds the stream.
- Ideation runs `--restricted` with only Read, Grep, Glob and Write, no MCP servers and no subagents.
- A subscription usage limit (rejected rate-limit event, limit error result or 429 text; a 429 from another service is classified the same way) ends the cycle as `blocked` (exit 2) with no retry loop and no API fallback. Like any blocked or failed job it quarantines that project: no claims and no intake until an operator inspects and requeues it after the limit window resets.

Linear for Claude Code uses the remote MCP server at `https://mcp.linear.app/mcp`, which needs one interactive OAuth login per worker account. Run this once and authenticate with `/mcp`, using the same server name and URL the runner passes:

```sh
claude --strict-mcp-config --mcp-config '{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}'
```

Until that login exists, Claude-engine development cycles report blocked without writes; ideation cycles do not need it. Workers choose a default engine through `engine` in their configuration (`install-local.mjs --engine claude`); an enqueued job's `engine` field overrides it.

## Ideation and owner approval

A project enables ideation in `.agent-team.json`:

```json
{ "ideation": { "enabled": true, "backlogCap": 10, "batchSize": 3, "minimumIntervalHours": 24,
  "ideaLabel": "Idea", "proposedState": "Backlog", "approvedState": "Todo", "rejectedState": "Canceled" } }
```

`enqueue PROJECT --ideate --proposal-limit N` (or `runner.mjs --ideate`) runs the read-only `team-ideation` role once. It proposes substantial features with problem, benefit, scope, success criteria, relative effort, evidence and timing; the runner fails the cycle if the worktree or branch changed. The worker validates the proposals, then creates Linear issues in the proposed state carrying the idea label, deduplicated by title and a durable marker, never beyond `backlogCap` unfinished ideas per project (Done/Canceled free capacity). The worker needs `LINEAR_API_KEY` for that publication and skips the model entirely when the backlog is full or the key is missing.

The owner approves by moving a card to the approved state and declines by moving it to the rejected state. The team never changes those states, never adds the ready label to an unapproved idea and never implements a pending proposal. The intake service (`core/intake.mjs`, through the tracker adapter) polls Linear without a model: approved, unblocked ideas without `agent:blocked`/`owner:decision` labels become `--publish` development jobs pinned to that issue (`--auto-merge` when the project authorizes delivery) on the freshly fetched delivery branch; approvals withdrawn while a job is still queued cancel it, and an idea whose earlier job was canceled or skipped can be approved again. It refills proposals only when capacity remains, no job is active or quarantined, and the cooldown has passed. Before each development run the worker rechecks approval through the API and reports idle without a model if it was withdrawn.

## Owner interaction and visibility

Use `/team what is happening?`, `/team prioritize the upload issue`, or `/team ask me before changing the import flow` in the existing remote OpenCode interface. The owner agent reads the current project manifest and records messages in Linear. A plain chat with the normal agent can do the same when explicitly asked.

Each project's `ownerInboxIssue` is a durable message thread. Coordinators check it and active-issue comments at start and before implementation, review and publishing; actionable messages are acknowledged once by comment ID. This is checkpoint-based delivery, not an instantaneous interrupt. `queueProjectId` maps the project to the shared execution queue.

`OWNER_PREFERENCES.md` is the shared style/communication policy: concise notes, code consistent with its surroundings, no meta commentary, and docs describing current behavior rather than patches. Consequential decisions get a recommendation and focused question, labeled owner:decision, with dependent work paused.

Publishing-enabled work uses coherent checkpoint commits and early draft PRs for visibility. Drafts report unrun/failed checks; they become ready only after independent testing/review. UI work includes inspected screenshots and reproducible preview instructions where feasible. Local-only artifacts are identified as such; automatic preview deployment is not implemented.

## Shared coordinator and workers

Copy the example configs into private local config files (for example `coordinator.local.json` and `worker.local.json`). Register every project once on the coordinator and map eligible projects on each worker. `concurrency` limits simultaneous projects per worker.

Provide `AGENT_TEAM_TOKEN` through a private environment/service file on the coordinator and clients. Use a cryptographically generated token of at least 24 characters, not a committed example token. This is a single-owner/trusted-worker control plane; the token grants queue administration, not per-user permissions. It is removed from the model runner environment.

```sh
# Coordinator machine; token already in environment
node core/queue.mjs --config coordinator.local.json

# Any eligible worker; token already in environment
node core/worker.mjs --config worker.local.json

# A client on the same host, or set URL to the Tailscale HTTPS endpoint
export AGENT_TEAM_URL=http://127.0.0.1:4310
node core/cli.mjs enqueue my-project --issue KEY-6 --key my-project-first-pilot
node core/cli.mjs list
```

Omit `--issue` to let the PM select from Todo + agent:ready in that project's Linear queue. PM can add at most two scoped supporting issues per cycle and maintains at most five ready issues. Ineligible pinned issues fail rather than silently substituting work.

Publishing is off by default. `enqueue ... --publish` explicitly authorizes the job's coordinator to commit only issue files, push the job branch and create a PR. It never authorizes merge/deployment. Without publishing, changes remain in the worker-local worktree and Linear moves accepted work to In Review with its location.

### Automatic merge

For an authorized project, submit `enqueue PROJECT --publish --auto-merge`, or use both flags with `runner.mjs`. The project manifest must contain:

```json
{
  "delivery": {
    "repository": "owner/repository",
    "baseBranch": "main",
    "requiredChecks": ["Agent verification"],
    "checkEnforcement": "github-required",
    "autoMergeAuthorized": true
  }
}
```

The developer implements, the tester verifies behavior, one reviewer approves the code, and the PM approves spec compliance and product value. The owner is consulted on consequential decisions rather than routine PR review. All final verdicts identify the same pushed commit. The coordinator records `approvals.tester`, `approvals.reviewer` and `approvals.pm`, each with `verdict`, `headSha` and its actual task `sessionId`; tester verdict is PASS and the others APPROVE. Distinct session IDs provide traceability, not cryptographic proof of independent reasoning.

The model cannot merge. After it exits, `delivery.mjs` validates local/remote HEAD, exact assigned branch, configured repository/base, clean source changes and the approvals. It requires every configured check to pass, re-reads immediately before one squash-merge attempt, and uses `--match-head-commit` without administrative bypass. The default `github-required` enforcement additionally requires GitHub-protected checks; unavailable protected-check lookup blocks delivery. Explicit `checkEnforcement: "runner"` uses configured checks without protected-check lookup, for owner-approved repositories whose plans lack branch protection. It does not prevent manual pushes and never activates as an automatic fallback.

Missing/stale approvals, new commits, pending/failed/skipped/missing required checks, GitHub refusal and uncertain merge results all block delivery. A confirmed MERGED state and actual merge commit are required for success. Logs retain the PR and recovery reason; there is no automatic CI-wait/retry loop yet. The next PM/coordinator cycle can reconcile confirmed merged PRs to Done; approval alone never closes an issue. Existing merge-triggered deployment follows each project's explicit authorization and is reported separately from merge success.

### Tailscale access

The existing x3d host can serve as the initial coordinator/worker. Keep the API bound to loopback and configure a dedicated Tailscale Serve HTTPS endpoint for port 4310. Inspect `tailscale serve status` first and preserve any existing remote-access service routes; do not replace them blindly. Set each remote worker/client `coordinatorUrl`/`AGENT_TEAM_URL` to that endpoint.

An alternative is binding the API directly to the host's Tailscale IPv4 address and accessing port 4310 over the encrypted tailnet. Do not expose it on `0.0.0.0` or Tailscale Funnel. The implementation accepts loopback or CGNAT-range IPv4 binds; it does not verify actual tailnet membership. No network/ACL changes are installed by this package.

### Persistent services and cadence

Use `install-local.mjs` to create private local configuration, a reusable token, and coordinator/worker user units with the actual Node/OpenCode paths:

```sh
node adapters/hosting/systemd/install-local.mjs --project /path/to/project --key project-key --repository owner/repository --dry-run
node adapters/hosting/systemd/install-local.mjs --project /path/to/project --key project-key --repository owner/repository --install
systemctl --user daemon-reload
systemctl --user start agent-team-coordinator.service agent-team-worker.service
```

The installer does not start services or install/enable timers. It preserves existing project mappings and tokens, and refuses conflicting settings. `--engine claude` records the worker's default engine and requires `claude` on PATH.

`configure-linear.mjs` adds the approval intake. It reads the key from a hidden terminal prompt, `--key-file`, or piped stdin, validates every mapped project's workspace, team, states and labels against Linear, and only then writes a private `linear.env`, `intake.json`, the `agent-team-intake.service` unit and a worker drop-in that supplies the key to the worker process (the worker removes it again before starting the model runner). Nothing is started; it prints the paths and the `systemctl --user` commands. The key never appears in output, logs, model subprocesses or repositories.

```sh
node adapters/hosting/systemd/configure-linear.mjs --dry-run
node adapters/hosting/systemd/configure-linear.mjs --install
systemctl --user daemon-reload && systemctl --user restart agent-team-worker.service && systemctl --user start agent-team-intake.service
```

The private service environment can be supplied to a one-off CLI invocation through `systemd-run --user --wait --pipe --collect -p EnvironmentFile=/absolute/path/to/service.env /absolute/path/to/node /absolute/path/to/cli.mjs list`.

`systemd/` contains coordinator, worker, intake and per-project enqueue timer examples. Adjust executable paths, toolkit location and environment before installing as user units. `%h/repo/agent-team` is an example location, not a requirement. Service files expect private configs and `service.env` under `~/.config/agent-team/` with `AGENT_TEAM_TOKEN`, `AGENT_TEAM_URL`, and a PATH containing OpenCode, Git and optionally gh. Credentials themselves remain outside repositories.

Enable the worker/coordinator after a successful pilot, then enable `agent-team-enqueue@my-project.timer` to submit an unpinned cycle hourly. Add timer instances for other registered projects. An active overlapping job produces HTTP 409; the timer submission fails without creating a duplicate. A sleeping/offline coordinator cannot enqueue or grant leases. User services may require login lingering for execution after logout.

Do not enable schedules before deciding model-provider spending limits. The system bounds concurrency, role steps, cycle count and elapsed time, but does not enforce a dollar budget. An idle PM cycle can still consume model tokens. On the Claude engine, subscription limits apply instead of a bill; a limit stops the affected job rather than retrying.

## Hosted control plane on Fly.io

The coordinator, the Linear intake and the dashboard can run away from your machines as one small Fly app; workers stay wherever the checkouts and model logins are and connect outbound. Nothing at home needs an open port.

- `fly-entrypoint.mjs` derives configuration from secrets and starts the three services on one machine with the SQLite database on the mounted volume. `fly.toml` exposes the dashboard on the app's HTTPS address (basic auth, `AGENT_TEAM_DASHBOARD_PASSWORD`) and the coordinator API on port 8443 (bearer token, `AGENT_TEAM_TOKEN`). `LINEAR_API_KEY` enables the intake; without it the app runs but polls nothing.
- Workers register each mapped project's `.agent-team.json` with the coordinator on start and every minute, so the intake and the dashboard know the projects without checkouts, and the page shows which worker was last seen for each project.
- While a runner executes, the worker reports evidence every 20 seconds: the journal, the last 200 steps, summary and stderr tail, from the run directory. The dashboard reads jobs, evidence and the registry from the coordinator API only; run pages, the live feed and member pages are that reported evidence.
- Chat is a queue job of kind `chat`: the dashboard enqueues it, a worker for that project claims it in a dedicated chat slot (beside builds, even while the project is on hold), posts the owner's message on the card, answers in character and posts the reply; the reply is the job result. If no worker is online the message waits, and the page says so.

```sh
fly launch --no-deploy --copy-config --name agent-team     # once; accept the app and volume
fly volumes create agent_team_data --size 1 --region arn
fly secrets set AGENT_TEAM_TOKEN=... AGENT_TEAM_DASHBOARD_PASSWORD=... LINEAR_API_KEY=...
fly deploy --config adapters/hosting/fly/fly.toml
```

Then point each worker's `coordinatorUrl` at `https://<app>.fly.dev:8443`, restart it, and stop the local coordinator, intake and dashboard services. The local dashboard can also stay and point at the same URL (`coordinatorUrl` in `dashboard.json`).

## Dashboard and everyday commands

`core/dashboard.mjs` serves the status page (default `http://127.0.0.1:4311`, or the Fly app address): worker presence per project, Claude subscription window usage and OpenCode token consumption as reported by runs, what the running coordinator and its subagents are doing right now, the queue with quarantine warnings, upcoming automatic runs, and every reported run with its delivery result, PR link and a detail page of steps, summary and stderr. Its only writes are the operator actions (propose ideas, release a held job, send a message), all sent to the coordinator API. `install-local.mjs` installs it locally as `agent-team-dashboard.service`.

Each member has a name, a voice and a portrait (`roster.mjs`, `portraits/`, regenerated with `portraits.mjs` and a Replicate key in `.env`). Clicking a member opens their page: current work, recent steps across runs, and a conversation panel. A message there is posted on the chosen Linear card of the selected project (the owner inbox by default) as "Owner → Name (title): …"; the member answers in a bounded read-only Claude session with the card's thread and its own recent work as context, from the latest retained worktree, and the reply is posted back signed "Name (title): …". Threads are the chat jobs themselves, so they follow the coordinator wherever it runs. Replies count against the worker's Claude subscription and are never retried.

`cli.mjs` finds the control-plane token in `~/.config/agent-team/service.env` when `AGENT_TEAM_TOKEN` is not exported, so the everyday commands are short:

```sh
node core/cli.mjs list
node core/cli.mjs enqueue my-project --issue KEY-5 --publish --auto-merge --engine claude --base origin/master --fetch
node core/cli.mjs requeue JOB_UUID      # only after inspecting a blocked or failed job
node core/cli.mjs cancel JOB_UUID       # queued jobs only
```

## Leases, failures and recovery

- SQLite transactions atomically claim jobs; a unique index allows one running job per project.
- Workers renew leases every third of the 90-second TTL. A failed heartbeat stops the runner; the worker allows the runner to terminate its detached child processes before escalation.
- Expired jobs become blocked, never automatically reassigned. Blocked/failed jobs quarantine the whole project from new claims while other projects continue.
- `node core/cli.mjs requeue JOB_UUID` is an explicit recovery action after inspecting the old worker's processes, retained changes and Linear state. Reconcile In Progress work before rerunning; the PM will not steal it.
- Requeue preserves the job ID/request but resets its result and lease; worker log files append across attempts. This is not a full attempt audit trail yet.
- New invocations create fresh worktrees; model sessions are not automatically resumed after a crash. Recovery is deliberate to avoid duplicate edits or publishing.
- Direct `runner.mjs` calls bypass the central queue and must not run on multiple hosts for the same project. Use workers for distributed operation.

Detailed evidence lives under each checkout's `.agent-team/runs/<id>/` (journal, events, stderr, summary). New worktrees live outside that checkout at `<project-parent>/.agent-team-worktrees/<project-root-hash>/<id>/`, preventing Node from resolving the primary checkout's dependencies through ancestor directories. Workers need write permission to that sibling container. Existing runs retain their recorded paths; journals are authoritative. Worker logs live in its configured state directory. The queue exposes bounded outcome/evidence references, not full model logs. No artifact upload, web dashboard, per-user authorization or automatic PR-merge observation is implemented yet.

## API

All routes require `Authorization: Bearer ...`; JSON request bodies are limited to 64 KiB. The bearer is the shared token, or a job token (`job.<id>.<mac>`) limited to its own job as described under Ephemeral workers.

| Route | Purpose |
| --- | --- |
| `GET /health` | Authenticated liveness |
| `GET /jobs` | Job summaries (never lease tokens) |
| `POST /jobs` | Validated enqueue; optional idempotency key, `engine`, `fetch`, `kind: ideation` |
| `POST /claim` | Atomic claim for registered worker project keys |
| `POST /jobs/:id/heartbeat` | Renew with current worker ID and lease token |
| `POST /jobs/:id/complete` | Record ready/idle using current lease |
| `POST /jobs/:id/fail` | Record blocked/failed using current lease |
| `POST /jobs/:id/requeue` | Explicit recovery of blocked/failed work |
| `POST /jobs/:id/cancel` | Cancel a still-queued job (intake uses this for withdrawn approvals) |
| `GET/POST /projects/:id/settings` | Owner overrides for the manifest's operational sections, and the effective manifest they produce |
| `GET /projects/:id/settings/history` | Every saved override document with author and note |
| `GET /projects/:id/tracker/lookup` | Teams, projects, labels and states from the tracker for the settings form |

## Provider-neutral core and adapters

Everything under `core/` and `agents/` is provider-neutral; `npm run lint` fails on any provider or project name there. Providers live in `adapters/`:

| Kind | Adapters | Chosen by |
| --- | --- | --- |
| engine | `opencode`, `claude` (billing `subscription`, `api`, `bedrock`), `cursor`, `codex` | worker/job `engine`, manifest `engine.default` |
| scm | `github` (gh), `gitlab` (glab + REST) | manifest `scm.kind` |
| tracker | `linear`, `github` (issues) | manifest `tracker.kind` |
| launcher | `local`, `ec2`, stubs `fargate`, `fly-machine` | manifest `worker.launcher` |
| artifacts | `local`, `s3` | worker `artifacts.kind` |
| integration | `slack`, `google-drive`, `hubspot`, generic `mcp` | manifest `integrations[].kind` |
| hosting | `local` (`up`), `systemd`, `fly`, `aws` | deployment only |

Interfaces are documented in [core/adapters.md](core/adapters.md). A version 2 manifest (`project.v2.example.json`) selects providers per project; version 1 manifests keep working with the original defaults.

## Integrations: external tools for any kind of task

A project lists the external systems its team may use; each one is a remote MCP server the engine gets alongside the tracker:

```json
"integrations": [
  { "kind": "slack", "channels": ["#ops"] },
  { "kind": "hubspot", "objects": ["contacts", "deals"], "roles": ["team-coordinator", "team-dev"] },
  { "kind": "google-drive", "url": "https://drive-mcp.example/mcp", "folders": ["1AbC..."] },
  { "kind": "mcp", "name": "billing", "url": "https://billing.example/mcp", "purpose": "invoice records" }
]
```

`agent-team init` asks for each integration's token once (`SLACK_BOT_TOKEN`, `HUBSPOT_ACCESS_TOKEN`, `GOOGLE_DRIVE_MCP_TOKEN`, `<NAME>_MCP_TOKEN`) and stores it with the other worker secrets. Inside a run the token travels only as a bearer header on that one server: the model process never sees any integration credential as a variable, granted or not. `roles` limits a server to the named roles; the engines translate that to their own tool permissions. The coordinator prompt names each tool, what it is for and the limits the manifest sets, and every external call appears in the run's live event stream on the dashboard. Slack and HubSpot default to the providers' hosted MCP endpoints; Google Drive and the generic kind name their server explicitly (a hosted connector or one you run).

## Team channel

Every project has a shared channel in the coordinator that active runs, the resident PM and the owner all read and post to. Inside a run the `team` command on PATH offers `team read [--after SEQ]`, `team say <text>` and `team claim|blocker|handoff|question <text>`; a run posts as its own role through its job lease and can only read its own project. The coordinator prompt has each cycle read the channel at its start and before publishing, so an owner note on the dashboard ("pause after this one", "the staging key changed") reaches every agent at its next checkpoint without a tracker round trip. The project page shows the channel live beside the PM conversation; the API is `GET/POST /projects/<id>/channel` and `POST /jobs/<id>/channel`.

## Teams: any set of personas, edited at runtime

Personas are data the coordinator stores. Open **Teams** in the dashboard to rename a member, change a voice, rewrite a prompt, add a subagent or remove one; every save is a new version with a note, revertible from the history, and each run records the team id and version it used. A project picks its team in **Settings** (`team.blueprint`) and which of its subagents the coordinator delegates to (`team.roles`); a repository needs nothing more than that one id.

What stays in the repository is the safety envelope. Every role's permissions come from the committed `roles.json` (a subagent the file does not know gets a fixed floor: no delegation, no questions, no tracker writes) and a stored team can only tighten them (no edit, no bash, no tracker). Delivery gates, SCM identity, charter and instructions are repository-owned as before. `team-coordinator`, `team-pm` and `team-owner` exist in every team because the runner, the resident PM and owner chat address them by name; their names and voices are free.

The toolkit ships two teams as seeds: the delivery team at the repository root (`roles.json`, `agents/`, `roster.mjs`) and `teams/research-desk`, a research-and-writing desk that works in a repository of notes and drafts and reaches documents, chat and CRM through integrations. Directory blueprints seed the store once; `AGENT_TEAM_BLUEPRINT` still selects which directory is the committed ceiling for a control plane. See [teams/README.md](teams/README.md).

## Worker environments: browsers and other tools for agents

An environment names what a worker machine offers a run beyond the repository. The toolkit ships `standard`, `browser` (a headless browser the engine drives through MCP tools: navigate, click, type, screenshot, read page text; screenshots land in the run evidence) and `full` (browser, container runtime, virtual display). **Environments** in the dashboard edits the catalog: capabilities from a fixed list, launcher defaults (image, AMI, instance type, setup) and packages for the worker image. A project selects its environment in **Settings** (`worker.environment`). The coordinator folds the environment's launcher defaults into cloud launches, `agent-team image` installs its packages, and the coordinator prompt tells the team which tools it has. A coordinator configuration may add environments under `environments` (see `coordinator.example.json`).

## Project memory

Each project has a git-backed memory owned by the coordinator (`<data>/memory/<project>/`): `charter.md`, `items/*.md` with frontmatter (`type`, `scope`, `confirmed`, `hits`, `status`) and `runs/<ticket>.md`. Every write is one commit; the dashboard's memory pages show items, history, diffs and let the owner edit, retire or revert. Before a run the worker asks the coordinator to `assemble` the most relevant items for the ticket's scopes under `memory.injectCapTokens`, appends them to the system prompt and journals the memory sha. Inside a run the `memory` command offers `memory search` and `memory propose`; proposals and the report's `learnings[]` land in a review queue that the resident PM curates after each run.

Seed a project's memory from its instruction files:

```bash
node core/seed-memory.mjs --project /path/to/project --dry-run
node core/seed-memory.mjs --project /path/to/project --coordinator http://127.0.0.1:4310
```

## Resident PM

`core/pm.mjs` runs on the control plane with the engine named in `pm.json` (`npm run pm`). It answers owner messages from the dashboard chat, watches the tracker and job completions, curates memory proposals into commits, and acts within the manifest's `pm.autonomy` (`observe`, `suggest`, `act`): it may enqueue ready work, comment and write observations on its own; state moves, `decision` items and spend above `pm.dailyCapUsd` go to the decision inbox for the owner.

## Project settings in the dashboard

The repository's `.agent-team.json` says what the project *is*: source control, base branch, required checks, whether auto-merge may ever be authorized, charter and instructions. Changing those is a commit and a review. How the project is *run* is an owner decision that changes more often, so the dashboard's Settings page (`/projects/<id>/settings`) lets the owner override the `tracker` scope (team, project, ready label, inbox issue; never the tracker kind), `engine` defaults, `worker` launcher and size, `memory` injection budget, `pm` autonomy and spend cap, `team.roles`, and `ideation` cadence without a commit.

Overrides live in the coordinator database as a small JSON document per project, validated by `validateOverrides` against an allowlist of sections and by normalizing the merged manifest before saving. Every consumer sees the same effective manifest: `GET /projects` returns it for intake and the resident PM, the coordinator's launcher reads it to choose compute, and workers fetch `/projects/<id>/settings` before each run and pass the document to the runner as `--settings-file`, which merges it and overlays the effective `.agent-team.json` in the worktree so the model reads exactly what the runner enforces (the overlay is never committed). The form shows the effective value of every field, marks overridden ones with the repository value on hover, stores only genuine deviations, and keeps a history with notes. Repository-owned values are listed read-only beneath the form.

## Ephemeral workers

With `worker.launcher: ec2` the coordinator starts an instance per job from `worker.ami` (or `ssm:/parameter` holding the current image) whose user-data runs `core/worker.mjs --once --job ID` and shuts down. The launched worker receives a job token derived from the shared token instead of the shared token itself: it can claim and report that one job, record its cost and read its project's settings and memory; every other route, manifest registration included, answers 403, and the token stops working when the job ends. The owner's CLI registers the manifest for such projects. Jobs unclaimed after `claimTimeoutMinutes` fail and their instance is terminated. `artifacts.kind: s3` uploads journal, events, stderr and diff at the end of each run and the dashboard links to them. See [adapters/hosting/aws/README.md](adapters/hosting/aws/README.md) for the control plane on AWS and the nightly AMI build.

## One command: `agent-team up`

```sh
export GH_TOKEN=...            # push branches, open pull requests, and the repository's issues
export ANTHROPIC_API_KEY=...   # or log the engine in on the worker host for subscription billing
npx @fumbleforce/agent-team up /path/to/checkout              # this machine, foreground
npx @fumbleforce/agent-team up /path/to/checkout --target aws # dedicated network, spot workers
```

`up` runs a preflight that lists every missing requirement at once (Node, Git, the manifest, ignores, the engine and its billing, the SCM and tracker tokens, AWS access for that target), creates the tracker labels and an owner inbox issue when the tracker adapter can (GitHub Issues does), registers the manifest, seeds memory from the instruction files and opens the dashboard. On the local target everything binds to loopback under a generated token and stops with Ctrl-C; on AWS it is `init`, `deploy`, `image` and `seed` in one go, and every step is idempotent so rerunning it is safe.

The defaults it applies are meant to be safe, cheap and complete: a dedicated VPC for the control plane and workers, one-shot spot workers that terminate with the job, the dashboard reachable only through a Session Manager tunnel, secrets in Parameter Store with the control-plane secrets out of the workers' reach, the PM in `suggest` autonomy with a daily spend cap, auto-merge off, and the `browser` environment so the team can look at what it builds.

### GitHub Issues as the tracker

A project on GitHub needs no second account: `tracker: { "kind": "github", "repository": "owner/repo", "readyLabel": "agent:ready" }` makes the repository's issues the board, addressed as `GH-12`. Workflow states are labels (`idea:proposed`, `agent:approved`, `agent:in-progress`, `agent:in-review`; a closed issue is done or rejected), which `up` creates. The same `GH_TOKEN` serves the SCM and the tracker unless `GITHUB_ISSUES_TOKEN` is set. Engines reach issues through GitHub's hosted MCP server.

### Dogfooding

This repository carries its own `.agent-team.json`: GitHub for code and issues, the delivery team with developer, tester and reviewer, the `browser` environment, `docs/PLATFORM.md` as the charter and `verify` as the required check. `agent-team up` on a checkout of this repository starts a team that proposes issues from the roadmap and, once an idea is approved, opens pull requests here.

## Pilot runbook for a new project

1. Add `.agent-team.json` (version 2) to the repository with `scm`, `tracker`, `engine`, `worker` (including `setup`, the command that installs the project's dependencies) and `delivery.requiredChecks`; leave `autoMergeAuthorized: false`.
2. `agent-team init /path/to/checkout`, then `agent-team deploy`. Open the dashboard it prints and edit the charter; `agent-team seed` fills memory from the instruction files.
3. Label one ticket with the ready label and `agent-team enqueue --issue KEY-1 --publish`; review the merge request, the run page and the memory proposals.
4. When the pilot run is clean, raise `pm.autonomy` and let intake pick up approved tickets on its own; both are settings in the dashboard.

See [adapters/hosting/aws/README.md](adapters/hosting/aws/README.md) for what the commands create and how to do it by hand.

## Platform roadmap

[docs/PLATFORM.md](docs/PLATFORM.md) maps the platform goals (self-provisioning, shared memory and communication, configurable teams, transparent dashboard, any task with external tools, owner interfaces, own ideas with task management, autonomous operation) to what runs today and what comes next.

## Next stages

1. Run an end-to-end real-model pilot and confirm exact Linear scope, role handoffs, checks and evidence.
2. Publish this toolkit in its own Git repository and pin revisions on workers. Add a second project to exercise reuse.
3. Enable user services and periodic triggers on the chosen always-on host; optionally expose a mobile-friendly status UI over Tailscale.
4. Add durable attempt history, artifact upload and application-level budget accounting.
5. Add containerized workers and per-worker credentials before untrusted/multi-user execution.
6. Add per-project parallel issue lanes and dependency-aware integration only after one-worker delivery is reliable.
