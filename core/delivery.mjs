import { spawnCommand } from './platform.mjs';
import * as fs from 'node:fs';
import path from 'node:path';
import { scmAdapter, DEFAULT_SCM } from '../adapters/scm/index.mjs';

const SHA = /^[0-9a-f]{40}$/;
const CHECK_ENFORCEMENT = ['protected', 'runner'];

// checkEnforcement `protected` (the historical `<scm>-required` spelling is accepted) adds the
// provider's protected-branch checks to the configured list; `runner` enforces only the list.
export function normalizeEnforcement(value) {
  if (value === undefined) return 'protected';
  return typeof value === 'string' && /^[a-z]+-required$/.test(value) ? 'protected' : value;
}

export function validateDelivery(config, autoMerge = false, scm = DEFAULT_SCM) {
  if (config !== undefined) {
    const adapter = scmAdapter(scm);
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['repository', 'baseBranch', 'requiredChecks', 'autoMergeAuthorized', 'checkEnforcement'].includes(key))
      || (config.checkEnforcement !== undefined && !CHECK_ENFORCEMENT.includes(normalizeEnforcement(config.checkEnforcement)))
      || !adapter.validateRepository(config.repository)
      || typeof config.baseBranch !== 'string' || !config.baseBranch || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(config.baseBranch)
      || config.baseBranch.startsWith('-') || config.baseBranch.startsWith('/') || config.baseBranch.endsWith('/')
      || config.baseBranch.includes('..') || config.baseBranch.includes('@{') || config.baseBranch === '@'
      || config.baseBranch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
      || (config.requiredChecks !== undefined && (!Array.isArray(config.requiredChecks)
        || config.requiredChecks.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())
        || new Set(config.requiredChecks).size !== config.requiredChecks.length))
      || (config.autoMergeAuthorized !== undefined && typeof config.autoMergeAuthorized !== 'boolean')) {
      throw new Error('Invalid .agent-team.json delivery configuration');
    }
  }
  if (autoMerge && (!config || config.autoMergeAuthorized !== true || !config.requiredChecks?.length)) {
    throw new Error('Auto-merge requires delivery.autoMergeAuthorized=true and explicit nonempty requiredChecks');
  }
  return config;
}

export function validateApprovals(approvals, headSha, roles = ['tester', 'reviewer', 'pm']) {
  if (!SHA.test(headSha)) throw new Error('Invalid local head SHA');
  const verdicts = { tester: 'PASS', reviewer: 'APPROVE', pm: 'APPROVE' };
  const sessions = new Set();
  for (const role of roles) {
    const approval = approvals?.[role];
    if (!approval || approval.verdict !== verdicts[role] || approval.headSha !== headSha
      || typeof approval.sessionId !== 'string' || !approval.sessionId.trim()
      || approval.sessionId !== approval.sessionId.trim() || sessions.has(approval.sessionId)) {
      throw new Error(`Missing, stale or non-independent ${role} approval`);
    }
    sessions.add(approval.sessionId);
  }
}

// Async commands allow cancellation to be observed before the mutation boundary.
export function deliveryExec(bin, args, { cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(bin, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} ${args.join(' ')}: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

export async function verifyWorktree({ worktree, branch, overlays = {}, excludedPaths = [], exec, signal, env }) {
  const git = (...args) => exec('git', ['-C', worktree, ...args], { cwd: worktree, env, signal });
  const head = (await git('rev-parse', 'HEAD')).trim();
  if ((await git('branch', '--show-current')).trim() !== branch) throw new Error('Local assigned branch mismatch');
  if ((await git('diff', '--cached', '--name-only', '-z')).length) throw new Error('Uncommitted staged issue changes');
  // Do not let assume-unchanged or newly hidden tracked source evade status.
  for (const entry of (await git('ls-files', '-v', '-z')).split('\0').filter(Boolean)) {
    if (/^[a-z]/.test(entry) || (entry[0] === 'S' && (!excludedPaths.includes(entry.slice(2))
      || fs.existsSync(path.join(worktree, entry.slice(2)))))) throw new Error('Hidden tracked worktree changes');
  }
  // Generated ignored dependencies/build artifacts are expected after testing.
  // Ignore-policy changes are tracked changes subject to the same review gates.
  const entries = (await git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')).split('\0').filter(Boolean);
  for (const entry of entries) {
    const name = entry.slice(3);
    if (Object.hasOwn(overlays, name)) {
      const file = path.join(worktree, name);
      if (fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8') === overlays[name]) continue;
    }
    throw new Error(`Uncommitted work outside setup overlays: ${name}`);
  }
  return head;
}

// Deterministic merge gate: the change request must belong to the configured repository, point
// at the assigned branch and head, pass every required check, and carry independent approvals
// from the configured approval roles. The provider confirms the merge before it is reported.
export async function deliver({ config, scm = DEFAULT_SCM, approvalRoles, prUrl, approvals, worktree, branch, overlays, excludedPaths,
  signal, env = process.env, exec = deliveryExec }) {
  let headSha;
  let mergeAttempted = false;
  const adapter = scmAdapter(scm);
  const checkEnforcement = normalizeEnforcement(config?.checkEnforcement);
  const checkSource = checkEnforcement === 'runner'
    ? 'Configured requiredChecks enforced by runner'
    : `Configured requiredChecks plus ${adapter.NAME} protected-branch checks`;
  const recovery = `Retain this ${adapter.CHANGE_ABBREVIATION} and worktree. PM recovery must inspect the existing ${adapter.CHANGE_ABBREVIATION}, revalidate gates and reconcile confirmed MERGED state; do not reselect the In Review issue or rerun implementation.`;
  const checkAbort = () => { if (signal?.aborted) throw new Error(`Delivery canceled: ${signal.reason || 'aborted'}`); };
  try {
    checkAbort();
    validateDelivery(config, true, scm);
    const parsed = adapter.parseChangeUrl(prUrl);
    if (!parsed || parsed.repository !== config.repository) throw new Error(`${adapter.CHANGE_ABBREVIATION} URL does not belong to configured repository`);
    const context = { url: prUrl, repository: config.repository, cwd: worktree, env, signal };
    const local = () => verifyWorktree({ worktree, branch, overlays, excludedPaths, exec, signal, env });
    headSha = await local();
    validateApprovals(approvals, headSha, approvalRoles);
    const view = async () => { checkAbort(); return adapter.view(exec, context); };
    const validateChange = change => {
      if (change.url !== prUrl || change.state !== 'OPEN' || change.isDraft !== false || change.baseRef !== config.baseBranch
        || change.headRef !== branch || change.headSha !== headSha || change.sameRepository !== true || change.mergeable !== true) {
        throw new Error(`${adapter.CHANGE_ABBREVIATION} identity, head or mergeability gate failed`);
      }
    };
    const checks = async () => {
      checkAbort();
      // Runner-only enforcement is an explicit project opt-in, never an error
      // fallback. Protected mode stays fail-closed on unavailable branch protection.
      const status = await adapter.checks(exec, context, { includeProtected: checkEnforcement !== 'runner' });
      if (!Array.isArray(status.all) || (checkEnforcement !== 'runner' && !Array.isArray(status.protected))
        || config.requiredChecks.some(name => !status.all.some(check => check.name === name)
          || status.all.filter(check => check.name === name).some(check => !check.passed))
        || (status.protected ?? []).some(check => !check.passed)) throw new Error('Required checks missing or not passing');
    };
    validateChange(await view());
    await checks();
    // Fresh reads immediately before the single mutation; the server enforces protection.
    if (await local() !== headSha) throw new Error('Local head changed between reads');
    validateApprovals(approvals, headSha, approvalRoles);
    await checks();
    validateChange(await view());
    checkAbort();
    mergeAttempted = true;
    await adapter.merge(exec, context, headSha);
    const merged = await view();
    if (merged.url !== prUrl || merged.state !== 'MERGED' || merged.headSha !== headSha || !SHA.test(merged.mergeCommit ?? '')) {
      throw new Error(`${adapter.NAME} did not confirm MERGED with an actual merge commit`);
    }
    return { state: 'merged', reason: `${adapter.NAME} confirmed MERGED with an actual merge commit`, checkEnforcement, checkSource, prUrl, headSha, mergeAttempted, mergeCommit: merged.mergeCommit,
      commitUrl: adapter.commitUrl(config.repository, merged.mergeCommit) };
  } catch (error) {
    return { state: 'blocked', reason: error.message, checkEnforcement, checkSource, prUrl, headSha, mergeAttempted, recovery };
  }
}
