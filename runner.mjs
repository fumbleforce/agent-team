#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliver, validateDelivery } from './delivery.mjs';

const REPORT = '.agent-team-result.json';
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Usage: node /path/to/agent-team/runner.mjs [options]
  --project PATH            Target Git project (default current directory)
  --issue TEAM-N            Pin exactly this issue; never substitute another
  --dry-run                 Default: read-only preflight and plan; no model call
  --execute                 Create evidence/worktree and run the coordinator
  --cycles N                1..5 scoped cycles (default 1)
  --timeout-minutes N       1..120 per cycle (default 45)
  --base REF                Local Git commit/ref (default HEAD); never fetches
  --model MODEL             Optional OpenCode model
  --publish                 Authorize commit/push/PR; requires --cycles 1
  --auto-merge              Deterministic merge gates; requires --publish, cycles 1
  --status                  Read-only lock and run journals; no preflight/model
  --help                    Show this help

Linux, single-host only. State: .agent-team/; retained branches: agents/<id>.
New worktrees: <project-parent>/.agent-team-worktrees/<root-sha256-12>/<id>.
The root hash uses the canonical (real) project path. Logs/locks stay in the
project's .agent-team/. Existing retained worktrees keep their recorded paths.
Shared config/roles load from this runner's package directory, not the cwd.
Only project config, AGENTS.md, .gitignore and configured charter/instructions
overlay the local base. Instruction paths must be safe relative text files.
Tracked environment secrets, SQLite databases/sidecars and known private keys
are excluded by filename using sparse checkout before any files materialize.
Excluded paths appear in dry-run/journal evidence; Git blobs are never inspected.
Resolved shared roles and worktree instruction paths use OPENCODE_CONFIG_CONTENT.
Preexisting OPENCODE_CONFIG_CONTENT is rejected. OpenCode still merges global,
project and OPENCODE_CONFIG settings; shared content is its inline config layer.
No global configuration is modified. This is not an OS sandbox.
Database/profile/central-API environment overrides are filtered by name pattern;
inherited E2E_*_LIVE toggles are set to 0. Model auth/provider variables remain.
AGENT_TEAM_TOKEN is never forwarded to the model process.
Root .gitignore must ignore .agent-team/ and .agent-team-result.json.
Locks are never broken automatically; inspect PID/work before manual removal.
No automatic cleanup, dependency installation, retries, fetch, or dollar cap.
Only cycle count and elapsed cycle time are bounded. Publishing requires gh auth.
Locks are per project: separate projects can run concurrently on one host.
This CLI opens no network listener; remote orchestration belongs on Tailscale.
Final execute output is journal JSON. Exit 0: ready/idle (read outcome);
exit 2: blocked; exit 1: failed; exit 130: interrupted. Invalid inputs exit 1.
Agent reports are claims, not independent proof that tests passed.
`;

export function parseArgs(args) {
  const options = { execute: false, cycles: 1, timeoutMinutes: 45, base: 'HEAD', publish: false, autoMerge: false };
  const seen = new Set();
  const values = { '--cycles': 'cycles', '--timeout-minutes': 'timeoutMinutes', '--base': 'base',
    '--model': 'model', '--project': 'project', '--issue': 'issue' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (Object.hasOwn(values, flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--cycles' || flag === '--timeout-minutes') {
        const max = flag === '--cycles' ? 5 : 120;
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
          throw new Error(`${flag} must be an integer from 1 to ${max}`);
        }
        options[values[flag]] = Number(value);
      } else options[values[flag]] = value;
    } else if (flag === '--execute') options.execute = true;
    else if (flag === '--dry-run') options.execute = false;
    else if (flag === '--publish') options.publish = true;
    else if (flag === '--auto-merge') options.autoMerge = true;
    else if (flag === '--status') options.status = true;
    else if (flag === '--help') options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (seen.has('--execute') && seen.has('--dry-run')) throw new Error('Choose --execute or --dry-run');
  if (options.status && [...seen].some(flag => !['--status', '--project'].includes(flag))) throw new Error('--status accepts only --project');
  if (options.publish && options.cycles !== 1) throw new Error('--publish requires --cycles 1 to avoid multiple PRs on a cumulative branch');
  if (options.autoMerge && (!options.publish || options.cycles !== 1)) throw new Error('--auto-merge requires --publish and --cycles 1');
  if (options.issue && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(options.issue)) throw new Error('--issue must be an exact issue identifier, e.g. FUM-123');
  return options;
}

function command(bin, args, cwd, env, { input, trim = true } = {}) {
  const result = spawnSync(bin, args, { cwd, env, input, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

export function isSensitivePath(filename) {
  return filename.split('/').some(part => {
    const name = part.toLowerCase();
    const example = /(?:^|[._-])(?:example|sample|template)(?:\.env)?$/.test(name);
    return ((!example && (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')))
      || name.startsWith('.secrets')
      || /\.(?:db|sqlite|sqlite3)(?:[-.](?:wal|shm|journal))?$/.test(name)
      || /^(?:id_(?:rsa|dsa|ecdsa|ed25519|xmss)(?:_sk)?|ssh_host_.+_key)$/.test(name));
  });
}

export function sparsePatterns(excludedPaths) {
  // Git's line-oriented pattern format cannot safely represent these names.
  // Fail closed before worktree creation rather than risk a partial exclusion.
  for (const filename of excludedPaths) {
    if (/[\r\n\x00]/.test(filename)) throw new Error(`Cannot safely sparse-exclude path: ${JSON.stringify(filename)}`);
  }
  // Anchored, literal gitignore patterns: escape wildcard syntax, backslashes,
  // comment/negation markers and whitespace (including trailing spaces).
  return ['/*', ...excludedPaths.map(filename => `!/${filename.replace(/[\\*?\[\]#!\s]/g, '\\$&')}`)].join('\n') + '\n';
}

function inspectBase(root, baseCommit, env) {
  const names = command('git', ['ls-tree', '-rz', '--name-only', baseCommit], root, env, { trim: false });
  if (names.includes('\ufffd')) throw new Error('Base filenames must be valid UTF-8 for safe sparse exclusion');
  const excludedPaths = names.split('\0').filter(filename => filename && isSensitivePath(filename));
  sparsePatterns(excludedPaths);
  return { excludedPaths, warnings: excludedPaths.length
    ? [`Sensitive tracked artifacts will not be materialized (${excludedPaths.length} paths). See excludedPaths; filenames only were inspected.`] : [] };
}

function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function acquireLock(directory, metadata) {
  const file = path.join(directory, 'lock.json');
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Runner lock exists: ${file}. Inspect it manually; stale locks are not automatically removed.`);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ ...metadata, pid: process.pid })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return () => fs.unlinkSync(file);
}

function safeDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected real directory: ${directory}`);
}

function worktreeContainer(root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const container = path.join(path.dirname(root), '.agent-team-worktrees', hash);
  const relative = path.relative(root, container);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error('Worktree container must be outside the project root');
  }
  validateDirectoryAncestors(container);
  return container;
}

// Validate existing ancestors even in dry-run. Missing containers are created
// one level at a time only on execute; never follow a symlink to another tree.
function validateDirectoryAncestors(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory()) throw new Error(`Expected real directory (symlinks forbidden): ${current}`);
  }
}

function relativeFile(value, textOnly = false) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\\:\x00-\x1f*?{}]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')
    || value.split('/').some(part => ['.git', '.agent-team', '.opencode', 'node_modules', 'database', 'secrets'].includes(part))) {
    throw new Error(`Unsafe relative file path: ${value}`);
  }
  if (isSensitivePath(value)) throw new Error(`Sensitive artifact cannot be an overlay/instruction: ${value}`);
  if (textOnly && !(value === '.cursorrules' || /\.(md|txt)$/.test(value))) {
    throw new Error(`Instruction/charter must be a .md/.txt file or .cursorrules: ${value}`);
  }
  return value;
}

// Validate every path component, including missing optional files and ancestors.
function readSafeFile(root, relative, optional = false) {
  relativeFile(relative);
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && optional) return null;
    if (!stat) throw new Error(`Required file missing: ${current}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Unsafe file or parent (symlinks forbidden): ${current}`);
    }
  }
  return fs.readFileSync(current, 'utf8');
}

function loadProject(root) {
  const raw = readSafeFile(root, '.agent-team.json');
  const config = JSON.parse(raw);
  if (!config || config.version !== 1 || !Array.isArray(config.instructions)
    || ['name', 'workspaceId', 'workspaceUrl', 'teamId', 'projectId', 'projectUrl', 'readyLabel'].some(key =>
      typeof config[key] !== 'string' || !config[key].trim())) {
    throw new Error('Invalid .agent-team.json: version 1, name, workspace/team/project identity, URLs, readyLabel and instructions are required');
  }
  for (const key of ['workspaceUrl', 'projectUrl']) {
    if (!/^https:\/\/[^\s]+$/.test(config[key])) throw new Error(`Invalid .agent-team.json ${key}`);
  }
  const charter = relativeFile(config.charter, true);
  const instructions = config.instructions.map(value => relativeFile(value, true));
  const files = { '.agent-team.json': raw };
  for (const relative of new Set(['AGENTS.md', '.gitignore', charter, ...instructions])) {
    const content = readSafeFile(root, relative, relative === 'AGENTS.md' && relative !== charter);
    if (content !== null) files[relative] = content;
  }
  return { config, files, instructions: [...new Set([charter, ...instructions])].filter(file => Object.hasOwn(files, file)) };
}

function loadSharedConfig(packageDir) {
  const config = JSON.parse(readSafeFile(packageDir, 'opencode.json'));
  if (!config?.agent || !config.agent['team-coordinator']) throw new Error('Shared opencode.json requires agent.team-coordinator');
  for (const [name, agent] of Object.entries(config.agent)) {
    if (!agent || typeof agent.prompt !== 'string') throw new Error(`Shared agent ${name} requires a prompt`);
    const match = /^\{file:\.\/((?:agents\/)[A-Za-z0-9_-]+\.md)\}$/.exec(agent.prompt);
    if (match) agent.prompt = readSafeFile(packageDir, match[1]);
    else if (agent.prompt.includes('{file:')) throw new Error(`Unsupported shared prompt reference: ${agent.prompt}`);
  }
  if (config.instructions !== undefined && !Array.isArray(config.instructions)) throw new Error('Shared instructions must be an array');
  config.instructions = (config.instructions || []).map(file => {
    relativeFile(file, true);
    readSafeFile(packageDir, file);
    return path.join(packageDir, file);
  });
  return config;
}

function overlayFiles(worktree, files) {
  for (const [relative, content] of Object.entries(files)) {
    let parent = worktree;
    for (const part of relative.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      safeDirectory(parent);
    }
    const destination = path.join(worktree, relative);
    const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Unsafe overlay destination: ${destination}`);
    fs.writeFileSync(destination, content);
  }
}

export function modelEnvironment(env, config) {
  const filtered = { ...env };
  delete filtered.AGENT_TEAM_TOKEN;
  for (const key of Object.keys(filtered)) {
    if (/(?:^|_)(?:DATABASE_(?:URL|DIR)|USER_DATA_DIR|CENTRAL_API_BASE_URL)$/.test(key)) delete filtered[key];
    if (/^E2E_.*_LIVE$/.test(key)) filtered[key] = '0';
  }
  filtered.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return filtered;
}

export function validateResult(result, { autoMerge = false } = {}) {
  const keys = ['outcome', 'issue', 'summary', 'prUrl'];
  // Approval errors are delivery blockers, preserving the readable coordinator report.
  if (autoMerge && result?.outcome === 'ready' && Object.hasOwn(result, 'approvals')) keys.push('approvals');
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== keys.length || !keys.every(key => Object.hasOwn(result, key))
    || !['ready', 'blocked', 'idle'].includes(result.outcome)
    || !(result.issue === null || (typeof result.issue === 'string' && result.issue.trim()))
    || typeof result.summary !== 'string' || !result.summary.trim()
    || !(result.prUrl === null || (typeof result.prUrl === 'string' && /^https:\/\/[^\s]+$/.test(result.prUrl)))) {
    throw new Error(`Malformed ${REPORT}: expected exactly {outcome: ready|blocked|idle, issue: string|null, summary: nonempty string, prUrl: HTTPS URL|null}`);
  }
  return result;
}

export function coordinatorPrompt(options, cycle) {
  return `Perform exactly ONE scoped unattended team cycle (${cycle}/${options.cycles}) in this isolated worktree.
Read .agent-team.json first, then its configured charter and instructions, and AGENTS.md if present.
Read workspaceId, workspaceUrl, teamId, projectId, projectUrl and readyLabel from .agent-team.json; do not guess a different Linear scope.
Verify the connected Linear workspace ID matches workspaceId before any writes.
${options.issue ? `Pinned issue: ${options.issue}. PM must verify eligibility, configured workspace/team/project membership and readyLabel for ONLY ${options.issue}. Do not select or substitute any other issue. If unavailable or ineligible, report blocked with issue ${options.issue}; otherwise claim only that issue. Every result must identify ${options.issue}.` : 'PM selects and claims one eligible issue in that configured Linear project using readyLabel, or reports idle if none are eligible.'}
Delegate to UX if needed, then developer, tester, one reviewer and PM final acceptance. Allow at most TWO repair rounds, then report blocked if unresolved.
Handle dependency needs within the time budget; the runner does not install dependencies. Run appropriate targeted tests and record actual commands/results and any gaps. Do not claim unrun tests passed.
Update Linear to In Review when locally ready or PR ready. NEVER automatically mark Done.
${options.publish ? 'Publishing is explicitly authorized: commit only intended issue files, push this agents/ branch, and create a PR when ready. Never force push or modify the primary checkout.' : 'Publishing is NOT authorized: do NOT commit, push, create a PR, or merge. Leave changes in this worktree for review.'}
${options.autoMerge ? 'AutoMerge mode: commit/push before final tester PASS, one independent reviewer APPROVE, and PM final spec/product-sense APPROVE gates. All three must examine the same exact final 40-hex git HEAD SHA in distinct Task sessions and return verdict, headSha and sessionId through Task. Assemble these facts in an additional approvals object with tester, reviewer and pm keys in the ready report. Any new commit invalidates all three approvals. The agent NEVER merges itself; only the deterministic runner may merge. Keep In Review until a later PM reconciliation verifies the actual merged PR. Session attestations provide traceability, not cryptographic proof.' : 'PM final spec/product-sense acceptance is also required.'}
Preserve existing work, setup overlays, secrets and databases. Do not access or modify the primary checkout or other worktrees. Do not start detached background work.
This worktree uses sparse checkout to omit tracked sensitive artifacts. Preserve sparse rules and skip-worktree bits. Never restore, read through Git, stage, delete, or materialize excluded paths; use synthetic test data instead.
Do not stage or commit ${REPORT} or .agent-team/. Never use blanket git add; inspect and stage only intended issue changes, excluding unrelated setup overlays.
Before exiting, write a regular UTF-8 JSON file ${REPORT} in the worktree root with EXACTLY these keys${options.autoMerge ? ' plus approvals for a ready outcome' : ''}:
{"outcome":"ready"|"blocked"|"idle","issue":string|null,"summary":string,"prUrl":string|null}
summary must be nonempty, concise (at most 150 words), and include test evidence/limitations. Keep the Linear issue summary at most 150 words too; put detailed evidence in the run logs. prUrl must be null unless a PR exists (otherwise its HTTPS URL).
Report ready only after tester, reviewer and PM final acceptance. Report blocked for unresolved failures or missing access/configuration; idle only when no eligible issue exists.
Soft scheduling reminder: reserve the final 60 seconds of the cycle for the result file and concise issue summary. Finish implementation/testing/delegation before that reserve, write a valid report first, then finalize the issue summary. If work is incomplete, report blocked before the deadline. This reminder does not extend or change the hard timeout.
The per-cycle deadline is ${options.timeoutMinutes} minutes; cycle/time bounds are not a spending cap.`;
}

// Detached Linux process groups let us stop descendants even if the leader exits.
export function runChild({ args, cwd, env, stdoutFd, stderrFd, timeoutMs, graceMs = 5_000, signal, onSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', args, { cwd, env, detached: true, stdio: ['ignore', stdoutFd, stderrFd] });
    let reason = null;
    let timer;
    let killTimer;
    let closed = false;
    let escalated = false;
    let exitCode = null;
    let exitSignal = null;
    let spawnError;
    const kill = sig => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') spawnError = error; }
    };
    const finish = () => {
      if (!closed || (reason && !escalated)) return;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (spawnError) reject(spawnError);
      else resolve({ exitCode, exitSignal, reason });
    };
    const stop = why => {
      if (reason) return;
      reason = why;
      kill('SIGTERM');
      // Always wait for escalation, even if the leader closes before descendants.
      killTimer = setTimeout(() => { kill('SIGKILL'); escalated = true; finish(); }, graceMs);
    };
    const abort = () => stop(String(signal.reason || 'interrupted'));
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, sig) => {
      closed = true;
      exitCode = code;
      exitSignal = sig;
      // Clean any lingering group before allowing another cycle, even on success.
      try { process.kill(-child.pid, 0); stop('lingering-processes'); } catch (error) {
        if (error.code !== 'ESRCH' && child.pid) spawnError = error;
      }
      finish();
    });
    child.once('spawn', () => {
      try { onSpawn?.(child.pid); } catch (error) { spawnError = error; stop('journal-error'); }
      if (signal?.aborted) abort();
    });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
}

function digest(journal) {
  return `# Agent run ${journal.id}\n\nState: ${journal.state}\nBase: ${journal.base} (${journal.baseCommit || 'unresolved'})\nBranch: ${journal.branch}\nWorktree: ${journal.worktree}\nPublish authorized: ${journal.publish}\n\n`
    + `## Sensitive tracked paths excluded from checkout\n\n${(journal.excludedPaths || []).map(filename => `- ${JSON.stringify(filename)}`).join('\n') || 'None identified.'}\n\n`
    + journal.cycles.map(cycle => `## Cycle ${cycle.number}: ${cycle.state}\n\n${cycle.result ? `Outcome: ${cycle.result.outcome}\nIssue: ${cycle.result.issue ?? 'none'}\nPR: ${cycle.result.prUrl ?? 'none'}\n\n${cycle.result.summary}` : cycle.error || 'No validated report.'}\n`).join('\n')
    + `\n${journal.error ? `Error: ${journal.error}\n\n` : ''}Agent outcomes are reported claims; success does not independently prove tests passed. Inspect events.jsonl, stderr.log, changes and test evidence. Work is retained; no automatic cleanup.\n`;
}

function status(directory) {
  const lock = path.join(directory, 'lock.json');
  const runs = path.join(directory, 'runs');
  return {
    lock: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : null,
    runs: fs.existsSync(runs) ? fs.readdirSync(runs).sort().map(id => {
      try { return JSON.parse(fs.readFileSync(path.join(runs, id, 'journal.json'), 'utf8')); }
      catch (error) { return { id, error: error.message }; }
    }) : [],
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { cwd = process.cwd(), env = process.env, output = console.log, graceMs = 5_000,
    timeoutMs, signal: externalSignal, packageDir = PACKAGE_DIR, warning = console.error } = dependencies;
  const options = parseArgs(argv);
  if (options.help) { output(HELP); return 0; }
  if (process.platform !== 'linux') throw new Error('This runner supports Linux only');
  const projectPath = path.resolve(cwd, options.project || '.');
  const root = fs.realpathSync(command('git', ['rev-parse', '--show-toplevel'], projectPath, env));
  const git = (...args) => command('git', args, root, env);
  const stateDir = path.join(root, '.agent-team');
  if (options.status) { output(JSON.stringify(status(stateDir), null, 2)); return 0; }
  // Read and validate all project/shared inputs before creating any state.
  if (Object.hasOwn(env, 'OPENCODE_CONFIG_CONTENT')) throw new Error('Preexisting OPENCODE_CONFIG_CONTENT is not allowed; unset it explicitly');
  const project = loadProject(root);
  validateDelivery(project.config.delivery, options.autoMerge);
  const shared = loadSharedConfig(packageDir);
  const container = worktreeContainer(root);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const worktree = path.join(container, id);
  const preflight = () => {
    const versions = { git: git('--version'), opencode: command('opencode', ['--version'], root, env) };
    if (options.publish) versions.gh = command('gh', ['auth', 'status'], root, env);
    const baseCommit = git('rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`);
    return { versions, baseCommit, ...inspectBase(root, baseCommit, env) };
  };
  if (!options.execute) {
    output(JSON.stringify({ mode: 'dry-run', root, ...options, ...preflight(),
      worktree, overlays: Object.keys(project.files),
      sharedPackage: packageDir, agents: Object.keys(shared.agent), instructions: project.instructions,
      prompt: coordinatorPrompt(options, 1) }, null, 2));
    return 0;
  }
  // Require repository-local ignores rather than modifying shared Git excludes.
  for (const ignored of ['.agent-team/', REPORT]) {
    git('check-ignore', '--no-index', '--quiet', ignored);
  }
  safeDirectory(stateDir);
  const release = acquireLock(stateDir, { id, startedAt: new Date().toISOString(), root });
  const runDir = path.join(stateDir, 'runs', id);
  const journal = { id, state: 'starting', startedAt: new Date().toISOString(), base: options.base,
    branch: `agents/${id}`, worktree, project: root, name: project.config.name, sharedPackage: packageDir,
    publish: options.publish, options, cycles: [] };
  const controller = new AbortController();
  const interrupt = sig => controller.abort(sig);
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  const onExternal = () => interrupt(externalSignal.reason || 'interrupted');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  externalSignal?.addEventListener('abort', onExternal, { once: true });
  if (externalSignal?.aborted) onExternal();
  let stdoutFd;
  let stderrFd;
  const persist = () => {
    atomicJson(path.join(runDir, 'journal.json'), journal);
    fs.writeFileSync(path.join(runDir, 'summary.md'), digest(journal), { mode: 0o600 });
  };
  try {
    safeDirectory(path.join(stateDir, 'runs'));
    fs.mkdirSync(runDir, { mode: 0o700 });
    stdoutFd = fs.openSync(path.join(runDir, 'events.jsonl'), 'ax', 0o600);
    stderrFd = fs.openSync(path.join(runDir, 'stderr.log'), 'ax', 0o600);
    persist();
    Object.assign(journal, preflight());
    persist();
    for (const message of journal.warnings) {
      const text = `Preflight warning: ${message} ${JSON.stringify(journal.excludedPaths)}`;
      fs.writeSync(stderrFd, `${text}\n`);
      warning(text);
    }
    if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
    validateDirectoryAncestors(container);
    safeDirectory(path.dirname(container));
    safeDirectory(container);
    git('worktree', 'add', '--no-checkout', '-b', journal.branch, worktree, journal.baseCommit);
    command('git', ['sparse-checkout', 'set', '--no-cone', '--stdin'], worktree, env,
      { input: sparsePatterns(journal.excludedPaths) });
    command('git', ['checkout'], worktree, env);
    for (const filename of journal.excludedPaths) {
      if (fs.lstatSync(path.join(worktree, filename), { throwIfNoEntry: false })) {
        throw new Error(`Sparse checkout failed to exclude ${JSON.stringify(filename)}`);
      }
    }
    overlayFiles(worktree, project.files);
    const childEnv = modelEnvironment(env, { ...shared,
      instructions: [...shared.instructions, ...project.instructions.map(file => path.join(worktree, file))] });
    for (const ignored of ['.agent-team/', REPORT]) command('git', ['check-ignore', '--no-index', '--quiet', ignored], worktree, env);
    for (let number = 1; number <= options.cycles; number++) {
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
      // Previous validated reports remain in the journal; a new cycle must write its own.
      fs.rmSync(path.join(worktree, REPORT), { force: true });
      const cycle = { number, state: 'running', startedAt: new Date().toISOString() };
      journal.cycles.push(cycle);
      journal.state = 'running';
      persist();
      const args = ['run', '--agent', 'team-coordinator', '--format', 'json', '--auto', '--dir', worktree];
      if (options.model) args.push('--model', options.model);
      args.push(coordinatorPrompt(options, number));
      fs.writeSync(stdoutFd, `${JSON.stringify({ type: 'runner.cycle.start', cycle: number })}\n`);
      try {
        Object.assign(cycle, await runChild({ args, cwd: worktree, env: childEnv, stdoutFd, stderrFd,
          timeoutMs: timeoutMs ?? options.timeoutMinutes * 60_000, graceMs, signal: controller.signal,
          onSpawn: pid => { cycle.pid = pid; persist(); } }));
        if (cycle.reason || cycle.exitCode !== 0) throw new Error(`Coordinator stopped: ${cycle.reason || cycle.exitSignal || `exit ${cycle.exitCode}`}`);
        const reportPath = path.join(worktree, REPORT);
        const stat = fs.lstatSync(reportPath);
        if (!stat.isFile() || stat.size > 1_048_576) throw new Error(`Invalid report file: ${REPORT}`);
        const result = validateResult(JSON.parse(fs.readFileSync(reportPath, 'utf8')), options);
        if (options.issue && result.issue !== options.issue) throw new Error(`Report must identify pinned issue ${options.issue}; substitutions are forbidden`);
        if (options.issue && result.outcome === 'idle') throw new Error('Pinned issues must report ready or blocked, not idle');
        if (!options.publish && result.prUrl !== null) throw new Error('Coordinator reported a PR without --publish authorization');
        cycle.result = result;
        cycle.state = cycle.result.outcome;
        if (options.autoMerge && result.outcome === 'ready') {
          journal.delivery = cycle.delivery = await deliver({ config: project.config.delivery, prUrl: result.prUrl,
            approvals: result.approvals, worktree, branch: journal.branch, overlays: project.files,
            excludedPaths: journal.excludedPaths, signal: controller.signal, env, exec: dependencies.deliveryExec });
          cycle.state = controller.signal.aborted ? 'interrupted' : cycle.delivery.state === 'merged' ? 'ready' : 'blocked';
        }
      } catch (error) {
        cycle.state = controller.signal.aborted ? 'interrupted' : 'failed';
        cycle.error = error.message;
        throw error;
      } finally {
        cycle.finishedAt = new Date().toISOString();
        persist();
      }
      journal.state = cycle.state;
      if (cycle.state !== 'ready') break;
    }
  } catch (error) {
    journal.state = controller.signal.aborted ? 'interrupted' : 'failed';
    journal.error = error.message;
  } finally {
    journal.finishedAt = new Date().toISOString();
    const result = journal.cycles.at(-1)?.result;
    journal.outcome = journal.state;
    journal.issue = result?.issue ?? options.issue ?? null;
    journal.summary = journal.error || (journal.delivery?.state === 'blocked'
      ? `${journal.delivery.reason}. ${journal.delivery.recovery}` : result?.summary) || 'No validated report.';
    journal.prUrl = result?.prUrl ?? null;
    try {
      if (fs.existsSync(runDir)) persist();
    } finally {
      if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      externalSignal?.removeEventListener('abort', onExternal);
      release();
    }
  }
  output(JSON.stringify(journal));
  return journal.state === 'interrupted' ? 130 : journal.state === 'failed' ? 1 : journal.state === 'blocked' ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Runner: ${error.message}`);
    process.exitCode = 1;
  });
}
