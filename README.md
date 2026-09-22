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

The first time you sign in, the app opens on a guide that takes you through it step by step: create a project, connect where the code lives and your task board, connect the code and choose how the models are paid for. When the app runs on the machine that has the code, one button clones the repository and starts the worker; for any other machine the guide gives one short command with a single-use link (`agent-team connect <link>`, and `agent-team work` from then on), so no token is ever copied by hand. Anything that later needs a person — a decision outside the team's bounds, work whose outcome is unknown, a merge that was cut off — waits under **Needs you**.

You can also create a project in the app (the button under the project list) and connect its code host, task board, chat and documents from its Integrations page, which walks through each product's setup.

`up` starts the coordinator and one worker on this machine, registers the checkout as a project with the default team, and prints a one-time link for creating the owner account. Everything is served from `http://127.0.0.1:4310`.

### Using it from another repository on this machine

The package is not published, so until it is, link this checkout instead of installing it. Once, in this checkout:

```sh
npm ci
npm run build:web
npm link               # puts `agent-team` on your PATH, pointing at this checkout
```

Then in any other repository:

```sh
cd /path/to/other-repo
agent-team up          # the current folder is the checkout; add --engine or --port as needed
```

If you would rather have it as a dependency of that repository than as a global command, link it there as well and run it through `npx`:

```sh
cd /path/to/other-repo
npm link @fumbleforce/agent-team
npx --no-install agent-team up
```

`--no-install` matters: without the link in place, a bare `npx agent-team` downloads and runs an unrelated package of that name from the public registry.

Things to know:

- A link runs the sources in this checkout as they are, so a `git pull` or an edit here takes effect the next time `agent-team` starts. `up` rebuilds the web app by itself when its sources are newer than the build.
- `npm link @fumbleforce/agent-team` does not touch the other repository's `package.json`, and a later `npm install` or `npm ci` there removes the link; run it again afterwards.
- With nvm, global links belong to one Node version. If `npm link @fumbleforce/agent-team` answers `404 Not Found`, or `agent-team` is not found, the shell is on a different Node version than the one `npm link` ran under: check with `node -v`, then either switch (`nvm use 24`, or `nvm alias default 24` to make it the default for new shells) or run `npm link` in this checkout under that version too. Linking by path works from any version: `npm link /path/to/agent-team`.
- Each checkout keeps its own database and settings under `~/.config/agent-team/local/<folder name>`, so two repositories do not share anything. To run two at once, give the second its own port: `agent-team up --port 4311`.
- To remove the link: `npm unlink -g @fumbleforce/agent-team`.

## Command line

`agent-team` below is `node bin/agent-team.ts` in this checkout, or the linked command from the section above. `agent-team --help` prints the list. In a terminal a command asks for what it was not given rather than stopping; every question has a flag, and without a terminal (a script, CI) nothing is asked and the flags decide.

| Command | What it does |
| --- | --- |
| `up [checkout] [--engine NAME] [--port N]` | Starts the coordinator and one worker on this machine for a checkout (default: the current folder) and registers it as a project. The engine defaults to the manifest's, then `claude`; the port to 4310. State lives in `~/.config/agent-team/local/<folder name>`. Ctrl+C stops both; a second Ctrl+C ends them without waiting for a running turn. |
| `connect [link] [checkout] [--engine NAME]` | Pairs this machine with a project made in the app, using the single-use link the app's guide gives (it asks for the link when you leave it out), then works for it. The machine's token is stored under `~/.config/agent-team/workers/<project>`, never typed. |
| `work [checkout]` | Works again for the project this checkout was connected to. In a folder that is not connected yet it asks for a link and connects first. |
| `demo` | Serves a sample organization on an in-memory database with a fake engine. Nothing is kept. |
| `setup-link [--url URL]` | Prints a one-time link for creating the owner account on a coordinator that has none. Without `AGENT_TEAM_TOKEN` set it means the local project's coordinator and uses its token; with it, the coordinator at `--url` (default `http://127.0.0.1:4310`). |
| `scorecard [--project SLUG] [--days N] [--json]` | The figures of [docs/ROADMAP.md](docs/ROADMAP.md) for a project, from its coordinator: autonomy, speed, delivery, what the team changed about itself, observability and safety. A figure with nothing to count says so. The same figures are the Scorecard tab of a project. |
| `migrate [--config FILE]` | Brings a database up to date: the one named in a coordinator config, or without one the local project's (this folder's, else the only one, else it asks). |
| `backup [--config FILE] [--out FILE]` | Copies a database, chosen the same way, into one file while it is in use; the file is named after the project and the date unless you say otherwise. Never overwrites; SQLite only, a Postgres server is backed up with its own tools. |
| `init aws [checkout] [--region R] [--profile P] [--permissions-boundary ARN] [--toolkit-ref COMMIT] [--instance-type T] [--setup CMD] [--force]` | Sets up an AWS deployment for a project: asks what it cannot work out from the manifest or the git remote, writes the deployment file, then offers the plan and the apply. |
| `deploy aws [--plan\|--apply] [--only STEP] [--skip STEP] [--permissions-boundary ARN]` | Plans, which changes nothing, then applies on a yes; `--apply` applies at once. With nothing set up yet it offers `init aws`. See below. |
| `status aws` | Shows what the AWS deployment has recorded and the control plane's state. |
| `destroy aws [--yes] [--roles] [--data] [--secrets]` | Lists what would be deleted and deletes it after a yes, or with `--yes`. |
| `call <tool> [json]` | Calls a platform tool from inside a turn, for engines that cannot mount the tool endpoint. Not for people. |

The config directory is `AGENT_TEAM_CONFIG_DIR` when set, else `~/.config/agent-team`.

### Deploying to AWS

This puts the coordinator on one small EC2 host and bakes an image that disposable workers start from. [adapters/hosting/aws/README.md](adapters/hosting/aws/README.md) has the detail: every step, the IAM boundaries, and the by-hand and Fargate routes.

You need the AWS CLI signed in to the target account, and its [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) to reach the host afterwards. The commands use the AWS CLI's own credentials; `init aws` records which profile is this project's, so you choose the account once.

1. **Push first.** The hosts do not get this checkout: they clone the toolkit from its repository at the `main` branch, so commits that are not pushed are not deployed.

2. **Set it up.** In the project's folder:

   ```sh
   agent-team init aws
   ```

   It asks for what it cannot work out, with its best guess as the default: the project's name and repository (from `.agent-team.json` when there is one, else from the `origin` remote, so a project needs no manifest), the region and the AWS CLI profile of the account, the worker size, the command that sets a fresh clone up, and the toolkit commit the hosts run. It writes `.agent-team/aws-deployment.json` inside the project, which never holds a secret value, only the names. A deployment belongs to its project: five projects in five AWS accounts each have their own file, and `deploy`, `status` and `destroy` act on the project whose folder you are in and cannot reach another's. The file records the AWS CLI profile of that project's account (it asks, offering `AWS_PROFILE`), and every later call uses it whatever the shell has exported; once something exists, commands refuse to run with credentials for a different account. Commit the file so teammates can manage the deployment, or ignore it; agents never see it. Then it offers the plan, and after the plan the apply, so this one command can take you all the way; say no at either point and carry on later with the steps below.

   Every question has a flag that answers it ahead of time (`--region`, `--profile`, `--instance-type`, `--setup`, `--toolkit-ref`), which is also how it runs without a terminal. It will not write over an existing file without a yes (or `--force`), and never over one that records resources already created.

3. **Plan.** This only reads (who you are, the default network if you chose it, and whether the account uses permissions boundaries) and prints what each step would create. Some locked-down accounts refuse new roles that do not carry a permissions boundary; you do not need to know its ARN, because the plan finds the boundary the account already uses and asks whether to attach it to the two roles. Without a terminal it names it, and `--permissions-boundary ARN` records it. In a terminal it then asks whether to apply; anything but a yes changes nothing.

   ```sh
   agent-team deploy aws
   ```

4. **Apply.** Secrets that are not generated are read from environment variables of the same name and stored in Parameter Store; a value already stored is left alone, and one that is in neither place is asked for, typed without being shown.

   ```sh
   export GH_TOKEN=...
   agent-team deploy aws --apply
   ```

   The steps are `secrets`, `network`, `iam`, `controlPlane`, `image`, `verify`. The file is saved after each, so after a failure run the same command again and it continues. `--only iam,controlPlane` or `--skip image` run a part; the image bake is the slow step.

5. **Open it.** The host has no public port. Forward 4310 with the command `deploy` prints at the end:

   ```sh
   aws ssm start-session --region <region> --target <instance id> \
     --document-name AWS-StartPortForwardingSession --parameters portNumber=4310,localPortNumber=4310
   ```

   Then open `http://127.0.0.1:4310`. The first visit needs the one-time setup link, which the control plane wrote to its log on first start: `aws ssm start-session --target <instance id>`, then `sudo journalctl -u agent-team.service | grep setup`. Stop a local `up` first, or forward to another `localPortNumber`, since both use 4310.

6. **Check and remove.**

   ```sh
   agent-team status aws
   agent-team destroy aws            # lists what would go (instances, images, security group, the dedicated network), deletes after a yes
   agent-team destroy aws --yes      # the same without the question
   ```

   The data volume (the database), the secrets and the roles stay unless you add `--data`, `--secrets` and `--roles`. Deleting the database is confirmed by typing the project's id.

A test deploy costs money while it exists: a `t3.small` and its volume all the time, a larger instance during the image bake, and each worker while it runs.

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
- **Credentials** stay in the environment of the process that uses them and are referred to by variable name: tracker tokens (`GITHUB_ISSUES_TOKEN` or `GH_TOKEN`, `LINEAR_API_KEY`), chat (`AGENT_TEAM_SLACK_APP_TOKEN` for inbound), optional embeddings (`AGENT_TEAM_EMBEDDINGS_URL`), the optional decision model that reads reports and sizes tasks for the PM (`TYPESAFE_API_KEY`, or the `OPENROUTER_API_KEY` already entered for models, which serves it too; the coordinator alone uses it, no worker sees it). `AGENT_TEAM_TOKEN` is the machine token workers present.
- **Skills.** Written methods the roles name, on the Skills tab of the organization: how to diagnose a bug, resolve a merge, write tests, write without the tells of generated prose. Every role applies `unslop` to everything a person reads; the rest are listed in each seat's prompt with one line and read with `skill.read` when the work calls for them. The platform ships a selection from [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering) and [pstack](https://github.com/cursor/plugins/tree/main/pstack) (both MIT, licenses in `blueprints/skills/LICENSES`); a skill that repeats what the platform already does (reviews, triage, orchestration, the tracker) was left out. Import more from any folder of SKILL.md files on GitHub, edit them in the app (every edit is a version you can put back), and give them to roles in the role editor.
- **Binding.** The coordinator binds loopback or a tailnet address. It refuses every other address unless `AGENT_TEAM_PUBLIC_BIND=1`.

## Hosting

`adapters/hosting/local` is what `up` uses. `systemd` prints and installs units for a persistent private host. `fly` and `aws` run the same single-port control plane from `adapters/hosting/shared/controlPlane.ts`; see the README in each folder.

## Measuring the team

`agent-team scorecard` shows where a project stands against the targets of the roadmap. The rows that compare the team with one model working alone come from the reference tasks in `reference/tasks`: a fixed set of work, each with a check the agents never see.

```sh
npm run reference -- run --arm team --engine claude            # the team, with its reviews
npm run reference -- run --arm solo --engine claude            # one seat alone, no review
npm run reference -- run --arm team --without Cleo             # the team without a seat: does the seat earn its place?
npm run reference -- run --arm team --seat-model Cleo=qwen/qwen3-coder,Rune=deepseek/deepseek-chat
npm run reference -- report                                    # quality and cost of the team against solo, defects caught, wrong briefs questioned
```

A run spends real model usage unless `--engine fake`, so it is never part of `npm test`. Results are written to `reference/results`.

## Development

```sh
npm test               # node --test over packages, adapters and scripts
npm run check          # type checks, Biome, the three lints and the web component tests
npm run test:sim       # a seeded long run of the scheduler against its safety invariants
AGENT_TEAM_TEST_STORAGE=postgres npm run test:postgres   # the package suite again, on the Postgres adapter (in-process, no server)
npm run test:e2e       # Playwright smoke over the demo (needs `npx playwright install chromium` once)
```

Tests never call a paid model or a real account. The component gallery at `/dev/ui` in the demo shows every primitive and pattern and is the visual reference. Rules for contributors, human or agent, are in [AGENTS.md](AGENTS.md).

## What has and has not been proven

Proven by the automated tests: the storage contract on SQLite, access control, the event log and stream resume, claims and leases, quarantine, deliberation, reviews and the merge gate on synthetic repositories, permissions and the write-scope gate, and every screen's API over the demo.

Not yet run against the real thing: a hosted Postgres (the adapter passes the suite on an in-process Postgres); the engine adapters other than the one checked in [docs/PLATFORM.md](docs/PLATFORM.md); chat, document-folder sync and OpenID Connect against real services; the Fly and AWS deployments. Treat each as unproven until a pilot has run it.
