# Agent Team

A platform for running teams of AI agents on real projects: one coordinator process that owns all state and serves everything on one port, workers that run one engine session per agent, and adapters for engines, source hosts, trackers, storage and hosting. The full design is in [docs/SPEC.md](docs/SPEC.md).

Status: the platform is implemented and covered by automated tests that use temporary repositories, in-memory databases, real HTTP on local ports and a fake engine. See [What has and has not been proven](#what-has-and-has-not-been-proven) before relying on it. Nothing is enabled merely by checking out this package.

## Quick start

Node 24 is required. The sources are TypeScript and Node runs them directly; only the web app has a build step.

```sh
npm ci
npm run build:web      # once, and after changing packages/web
npm run demo           # a sample organization on an in-memory database with a fake engine
```

To run a team on a checkout of your own:

```sh
node bin/agent-team.ts up /path/to/checkout --engine claude
```

`up` starts the coordinator and one worker on this machine, registers the checkout as a project with the default team, and prints a one-time link for creating the owner account. Everything is served from `http://127.0.0.1:4310`.

## Architecture

```text
Browser (React)  --cookie session-->  Coordinator :4310
                                        /api/*        JSON API
                                        /api/stream   live events, resumable
                                        /mcp          platform tools for agents (per-turn token)
                                        /worker/*     claim, heartbeat, steps, finish (machine token + lease)
                                        /*            the built web app
                                      Storage adapter (SQLite | Postgres)
Worker(s)  --outbound HTTP-->  Coordinator
  per turn: worktree -> engine CLI (adapter) -> parsed steps -> publish or deliver
```

- The coordinator owns all state and all decisions. Every change is an event in an append-only log, written in the same transaction as the tables the screens read, and relayed on one live stream.
- Workers own checkouts, worktrees, engine logins and secrets. They never receive user sessions. An agent holds only a token that is valid while its turn's lease is.
- An agent is a seat with a persona, roles, a provider and a model. Work arrives as queued items and runs as turns under 90-second leases. A turn whose outcome is unknown is never retried on its own: the smallest affected object is quarantined until a person releases it.
- Discussion between agents is structured: one proposal, one independent feedback block from each relevant teammate, at most one revision, then a recorded decision by the project manager seat. Anything outside the bounds the owner delegated lands in a single "Needs you" queue.
- Agents cannot push or merge. Publishing and merging are worker code behind a deterministic gate that re-reads approvals (tester, reviewer, project manager; never the author; same commit) right before the merge.

## Layout

| Path | What it holds |
| --- | --- |
| `packages/protocol` | Zod schemas for the API, events, platform tools, permissions and deliberation; every type is inferred from them |
| `packages/coordinator` | The server: accounts and access control, event log, turns and leases, deliberation, reviews and the merge queue, proposals, knowledge, costs, checks, issues, tracker and chat sync, the demo seed |
| `packages/worker` | Turn execution, worktrees with secret paths excluded, the write-scope gate, publish and the merge gate |
| `packages/web` | The React app: `tokens.css`, `ui/` primitives, `patterns/`, then `features/` per screen |
| `adapters/storage` | The storage contract, migrations, and the SQLite and Postgres adapters |
| `adapters/engine` | Engine CLIs behind one contract, plus a fake engine for tests and the demo |
| `adapters/scm`, `adapters/tracker` | Source hosts (publish, merge gates) and issue trackers |
| `adapters/artifacts`, `adapters/launcher`, `adapters/integration` | Artifact stores, worker launchers and external tool mounts |
| `adapters/hosting` | `local`, `systemd`, `fly` and `aws`, all on one port and the same two entrypoints |
| `blueprints/` | The default team and the shipped role library |

Provider names appear only under `adapters/`. `npm run lint` enforces that, the UI token rules and the rule that raw SQL stays inside `adapters/storage`.

## Configuration

- **Storage.** SQLite through Node's built-in driver by default. Postgres (and so Supabase) when the coordinator's `storage` is `{ "kind": "postgres", "url": "..." }` and `pg` is installed.
- **Sign-in.** Passwords, plus OpenID Connect when the organization's settings name an issuer. The first owner is created through the one-time setup link; others join by invitation with an organization role (owner, admin, member, viewer) and per-project access.
- **Project manifest.** `.agent-team.json` in the project's repository names the source host (`scm.kind`), the tracker (`tracker.kind` with its settings), `delivery` (repository, base branch, required checks, whether merging is authorized) and a `ceiling` that caps what any role may be granted. The worker reads the ceiling from the committed file at the base commit, so it wins even over the coordinator.
- **Credentials** stay in the environment of the process that uses them and are referred to by variable name: tracker tokens (`GITHUB_ISSUES_TOKEN` or `GH_TOKEN`, `LINEAR_API_KEY`), chat (`AGENT_TEAM_SLACK_APP_TOKEN` for inbound), optional embeddings (`AGENT_TEAM_EMBEDDINGS_URL`). `AGENT_TEAM_TOKEN` is the machine token workers present.
- **Binding.** The coordinator binds loopback or a tailnet address. It refuses every other address unless `AGENT_TEAM_PUBLIC_BIND=1`.

## Hosting

`adapters/hosting/local` is what `up` uses. `systemd` prints and installs units for a persistent private host. `fly` and `aws` run the same single-port control plane from `adapters/hosting/shared/controlPlane.ts`; see the README in each folder.

## Development

```sh
npm test               # node --test over packages, adapters and scripts
npm run check          # tsc --noEmit and the three lints
AGENT_TEAM_TEST_STORAGE=postgres npm run test:postgres   # the package suite again, on the Postgres adapter (in-process, no server)
npm run test:e2e       # Playwright smoke over the demo (needs `npx playwright install chromium` once)
```

Tests never call a paid model or a real account. The component gallery at `/dev/ui` in the demo shows every primitive and pattern and is the visual reference. Rules for contributors, human or agent, are in [AGENTS.md](AGENTS.md).

## What has and has not been proven

Proven by the automated tests: the storage contract on SQLite, access control, the event log and stream resume, claims and leases, quarantine, deliberation, reviews and the merge gate on synthetic repositories, permissions and the write-scope gate, and every screen's API over the demo.

Not yet run against the real thing: a hosted Postgres (the adapter passes the suite on an in-process Postgres); the engine adapters other than the one checked in [docs/PLATFORM.md](docs/PLATFORM.md); chat, document-folder sync and OpenID Connect against real services; the Fly and AWS deployments. Treat each as unproven until a pilot has run it.
