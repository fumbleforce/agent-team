# Platform goals and status

The toolkit's aim is one tool that provisions itself into an environment, runs a configurable team of agents with shared memory and a shared channel, shows everything it does, works on any task through external tools, is easy to talk to, proposes its own work and, in principle, can run an organisation on its own. This page maps each goal to what runs today, what the current change adds and what is next. Statuses are about this repository's code, not about pilots: nothing here is proven at scale until a real-model pilot has run it.

| Goal | Today | Next |
| --- | --- | --- |
| Provisions itself, with permissions and a persistent controller | `agent-team up` takes a checkout to a running team in one idempotent command: preflight, tracker bootstrap, then the local target (loopback, foreground) or AWS (dedicated VPC, scoped roles, SSM secrets, spot workers, tunnelled dashboard); `systemd` and `fly` adapters cover a persistent private host and Fly.io | The same `up/status/destroy` surface for Fly and a generic Docker host; per-integration IAM/OAuth scoping in the plan |
| Shared long-term memory and a channel between active agents | Git-backed project memory with search, assembly into prompts, proposals and PM curation; the team channel is read and posted to by every run, the PM and the owner through the coordinator, and a post that opens with `@Name` wakes that member's bounded chat session, which answers in the channel | Cross-project memory scopes for organisation-wide facts; channel threads an agent can subscribe to |
| Adapts to any set of personas and tasks | Teams are stored in the coordinator and edited on the dashboard (names, voices, prompts, added subagents) with versions and revert; the committed roles file stays the permission ceiling; a project selects its team and roles in settings; `teams/research-desk` is a non-coding seed | A task-kind abstraction so a cycle need not be a Git worktree and a tracker issue |
| A dashboard with the full stream of work | Live event stream from workers, per-run evidence, member pages, PM conversation, decisions, memory history, settings, spend; the channel joins the project page (this change) | Organisation view across projects; channel and integration calls as first-class timeline items with filters |
| Any task, easy external integrations | Integrations: Slack, Google Drive, HubSpot and any MCP server as manifest entries with per-role access, credentials as headers only, prompt notes and evidence; worker environments give runs a headless browser, a container runtime or a display, selected per project and edited on the dashboard | More integration kinds (email, calendar, spreadsheets), OAuth device flows inside `agent-team init`, a per-integration write log the owner can audit and revert, and more capabilities (GPU, persistent scratch volumes) |
| Easy to interface with and talk to | Dashboard chat with each member, owner inbox issue in the tracker, PM conversation with decisions, hands-free talk mode, channel posts (this change) | Slack and email as owner interfaces through the same integration adapters; a CLI `agent-team say` |
| Comes up with its own ideas and works with task management | Ideation runs propose issues into the tracker for owner approval; the resident PM maintains the backlog, opens decisions and enqueues work; intake polls the tracker; trackers are Linear and GitHub Issues | Jira; idea sources fed by integrations (support inbox, CRM signals) |
| Runs an organisation autonomously | Autonomy levels for the PM (`observe`, `suggest`, `act`), daily spend caps, auto-merge with deterministic gates, quarantine on uncertain execution | Multi-team orchestration (one blueprint per department, one channel per organisation), budgets and policies as data, and an explicit owner-set autonomy ceiling per project; this stays gated on pilots, isolation and per-worker credentials |

## How the pieces fit

```text
owner ── dashboard / tracker inbox / channel ──┐
                                               v
                        coordinator (SQLite): jobs, leases, evidence, memory, channel, decisions
                                               |
        intake (tracker) ── PM (resident) ── ideation ── workers (launcher: local, ec2, fargate, fly)
                                                              |
                                          runner: blueprint roles + project manifest
                                                              |
                          engine (opencode, claude, cursor, codex) with MCP servers:
                          tracker + integrations (slack, google-drive, hubspot, mcp)
                                                              |
                                  scm (github, gitlab) ── artifacts (local, s3)
```

## Security posture for integrations

- A credential reaches the worker through the deployment's secret store and is forwarded to the engine only as a bearer header on its own MCP server. `modelEnvironment` strips every known integration variable and anything ending in `_MCP_TOKEN` from the model process.
- The manifest is the grant: no integration, no server. `roles` narrows a server to named roles and each engine adapter enforces it through its own permission mechanism; the coordinator itself loses a server that does not name it.
- Prompt notes state each tool's purpose and limits, but prompts are not isolation. The worker's container or disposable host and the MCP server's own scopes are the boundary, as with every other capability in this toolkit.

## What is deliberately not claimed

- Hosted MCP endpoints are named where the providers publish them; where they do not, the manifest must point at a server the owner runs. This toolkit ships no MCP servers of its own.
- The cycle is still repository-shaped: one worktree, one tracker issue, one report file. A non-coding team works inside a repository of documents; a task model without Git is the next step listed above.
- The browser capability starts the Playwright MCP server with `npx` inside the run; the worker image must be able to fetch it (or carry it) and the `browser` environment's packages must be baked. Stored custom environments are not yet read by `agent-team image`; put their packages in the manifest's `worker.setup` until it is.
- Autonomous operation of a whole organisation is a direction, not a feature: it is reached by raising autonomy levels and adding teams once pilots, isolation and per-worker credentials are in place.
