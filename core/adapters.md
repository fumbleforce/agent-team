# Adapter interfaces

`core/**` and `agents/**` never name a provider or a project; `npm run lint` enforces it. Every provider lives under `adapters/<kind>/<name>.mjs` and is selected by name from configuration:

| Kind | Selected by | Directory index |
| --- | --- | --- |
| engine | worker `engine`, job `engine`, manifest `engine.default` | `adapters/engine/index.mjs` |
| scm | manifest `scm.kind` | `adapters/scm/index.mjs` |
| tracker | manifest `tracker.kind` | `adapters/tracker/index.mjs` |
| launcher | coordinator `launcher.kind`, manifest `worker.launcher` | `adapters/launcher/index.mjs` |
| artifacts | worker `artifacts.kind` | `adapters/artifacts/index.mjs` |
| integration | manifest `integrations[].kind` | `adapters/integration/index.mjs` |
| hosting | deployment scripts only, never imported by core | `adapters/hosting/*` |

Each index exports the list of kinds, a default, and a lookup that throws on unknown names. Adding a provider means adding one module and registering it in the index; core code stays untouched.

## engine

Drives a coding-agent CLI for one run. Implemented by `opencode`, `claude`, `cursor`, `codex`.

```
NAME, BIN, DEFAULT_MODEL, NEEDS_SYSTEM_PROMPT_FILE
BILLING_MODES, DEFAULT_BILLING            // e.g. subscription | api | bedrock
rateLimitPolicy(billing) -> { quarantineProject: boolean, retries: number }
environment(env, { roles, billing, denied, mcp }) -> env   // strips foreign credentials, injects config
preflight({ command, cwd, env, billing }) -> { versions, auth }  // throws before any model call
systemPrompt({ shared, role, instructions, memory }) -> string
invocation({ ideate, prompt, model, systemPromptFile, shared, mcp, denied }) -> { bin, args }
stopReason({ eventsFile, stderrFile }) -> { limit: boolean, summary }
parseEvent(event, context) -> step | null   // engine half of evidence.eventSteps
ask({ systemPromptFile, prompt, cwd, timeoutMs, env, signal, onDelta, onUsage, billing, tools, mcp, model, maxChars }) -> Promise<string>
```

`mcp` is the tracker adapter's `mcpServers()` map; `denied` are the SCM adapter's `MERGE_DENIALS` shell prefixes. Engines translate both to their own permission mechanism and document where a CLI has none.

## scm

Talks to the code host for change requests. Implemented by `github` (gh) and `gitlab` (glab + REST).

```
NAME, CLI, TOKEN_VARIABLE, CHANGE_NOUN, CHANGE_ABBREVIATION, MERGE_DENIALS
validateRepository(repository) -> boolean
parseChangeUrl(url) -> { repository, number } | null
isChangeUrl(url) -> boolean
linkText(url) -> string                    // dashboard label
commitUrl(repository, sha) -> string
publishInstructions({ repository, baseBranch, branch }) -> string   // injected into the coordinator prompt
auth({ command, cwd, env })                 // preflight, throws when logged out
view(exec, context) -> { state, headSha, baseBranch, headBranch, repository, draft, mergeable }
checks(exec, context, { includeProtected }) -> { required: [{ name, state }], source }
merge(exec, context, headSha) -> { mergeCommit }   // fails unless head still matches
```

## tracker

Reads and writes the issue tracker. Implemented by `linear`.

```
NAME, ISSUE_PATTERN, API_KEY_VARIABLE, MANIFEST_KEYS
mcpServers(trackerConfig) -> { tracker: { type, url } }
validateManifest(trackerSection) -> trackerSection
scopeInstructions(trackerSection) -> string
approvalStatus(manifest, issue) -> status
createClient({ apiKey, fetchImpl }) -> { snapshot, checkApproved, prepareApproved, publishProposals, issueComments, inboxComments, postComment, transition, lookup }
```

`lookup({ teamId })` is optional and returns `{ workspace, teams, teamId, projects, labels, states }` as identifiers and names only; the dashboard settings page uses it to offer choices, and falls back to free text when the adapter has none or the coordinator holds no tracker credential.

The MCP server is always exposed to engines under the neutral name `tracker`, so role permissions (`tracker_*`) do not change per provider.

## launcher

Starts compute for a queued job. Implemented by `local` (persistent worker, no-op start), `ec2`; `fargate` and `fly-machine` are stubs with the same shape.

```
NAME
create(options) -> { kind, start(job) -> handle, stop(handle), status(handle) -> { state } }
```

The coordinator calls `start` on enqueue when the kind is not `local`, records the handle in `launches`, and the watchdog calls `stop` for jobs unclaimed past the deadline.

## artifacts

Stores end-of-run files. Implemented by `local` (directory) and `s3`.

```
NAME
create(options) -> { kind, upload({ jobId, runDir, files }) -> { kind, location, files, links } }
```

## integration

An external tool the team may use during a run, reached through a remote MCP server. Implemented by `slack`, `google-drive`, `hubspot` and the generic `mcp` (any server the owner names).

```
NAME, TITLE, DEFAULT_URL, CREDENTIAL_VARIABLES, MANIFEST_KEYS
validate(config) -> config                 // adapter-specific keys (channels, folders, objects, purpose)
instructions(config) -> string             // one line for the coordinator prompt: what it is for, its limits
credential(env, config) -> token | null    // the worker-side secret sent as a bearer header on this server only
```

The index exposes `validateIntegrations(list)` (manifest normalization), `integrationServers(list, env)` (the engine's MCP map, merged with the tracker's), `integrationInstructions(list)` and `credentialVariables(list)`: every credential name, all of which `modelEnvironment` strips from the model process. An entry's optional `roles` limits the server to those roles; engines translate that to their permission mechanism (`access` in the engine `environment`/`invocation` calls). Names `tracker`, `memory` and `team` are reserved.

## hosting

Deployment glue, not imported by core: `systemd` (user units and installer), `fly` (entrypoint, `fly.toml`, Dockerfile), `aws` (control-plane deployment and worker AMI build).

## Teams and environments

Personas are not adapters: they are data the coordinator stores (`core/teams.mjs`, tables `teams` and `teams_history`). Directory blueprints (`core/blueprint.mjs`: the toolkit root and `teams/<name>`) seed the store once; afterwards the dashboard edits teams and every save is a version a run records. The committed `roles.json` stays the permission ceiling: `materialize(team, ceiling)` takes every role's permissions from it (or a fixed floor for subagents it does not know) and lets the stored team only add denials. A project selects a team with `team.blueprint` and reaches it through `GET /projects/<id>/team`; the worker writes it to a file the runner reads with `--team-file`.

Worker environments (`core/environments.mjs`, tables `environments` and `environments_history`) name what a machine offers a run: a fixed catalog of capabilities (`browser`, `docker`, `display`), launcher defaults and image packages. A project selects one with `worker.environment`; the coordinator folds its launcher fields into the launch, the worker passes it to the runner with `--environment-file`, and capabilities become MCP servers (`type: stdio`, which engines translate: OpenCode `local`, Claude Code `command/args`) plus a prompt note. `agent-team image` installs the environment's packages into the worker image.

## Manifest

`.agent-team.json` version 2 sections: `scm`, `tracker`, `engine`, `worker`, `memory`, `pm`, `team`, `integrations`, `delivery`. Version 1 files are upgraded in `core/manifest.mjs` with the first provider of each kind and the full persona pipeline, so existing projects run unchanged.
