# Adapter interfaces

`core/**` and `agents/**` never name a provider or a project; `npm run lint` enforces it. Every provider lives under `adapters/<kind>/<name>.mjs` and is selected by name from configuration:

| Kind | Selected by | Directory index |
| --- | --- | --- |
| engine | worker `engine`, job `engine`, manifest `engine.default` | `adapters/engine/index.mjs` |
| scm | manifest `scm.kind` | `adapters/scm/index.mjs` |
| tracker | manifest `tracker.kind` | `adapters/tracker/index.mjs` |
| launcher | coordinator `launcher.kind`, manifest `worker.launcher` | `adapters/launcher/index.mjs` |
| artifacts | worker `artifacts.kind` | `adapters/artifacts/index.mjs` |
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
NAME, CLI, CHANGE_NOUN, CHANGE_ABBREVIATION, MERGE_DENIALS
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

## hosting

Deployment glue, not imported by core: `systemd` (user units and installer), `fly` (entrypoint, `fly.toml`, Dockerfile), `aws` (control-plane deployment and worker AMI build).

## Manifest

`.agent-team.json` version 2 sections: `scm`, `tracker`, `engine`, `worker`, `memory`, `pm`, `team`, `delivery`. Version 1 files are upgraded in `core/manifest.mjs` with the first provider of each kind and the full persona pipeline, so existing projects run unchanged.
