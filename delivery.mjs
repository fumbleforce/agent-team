import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const fields = 'url,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,mergeStateStatus,mergeable,mergeCommit';

export function validateDelivery(config, autoMerge = false) {
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['repository', 'baseBranch', 'requiredChecks', 'autoMergeAuthorized', 'checkEnforcement'].includes(key))
      || (config.checkEnforcement !== undefined && !['github-required', 'runner'].includes(config.checkEnforcement))
      || typeof config.repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(config.repository)
      || ['.', '..'].includes(config.repository.split('/')[1])
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

export function validateApprovals(approvals, headSha) {
  if (!SHA.test(headSha)) throw new Error('Invalid local head SHA');
  const sessions = new Set();
  for (const [role, verdict] of [['tester', 'PASS'], ['reviewer', 'APPROVE'], ['pm', 'APPROVE']]) {
    const approval = approvals?.[role];
    if (!approval || approval.verdict !== verdict || approval.headSha !== headSha
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
    const child = spawn(bin, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
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

export async function deliver({ config, prUrl, approvals, worktree, branch, overlays, excludedPaths,
  signal, env = process.env, exec = deliveryExec }) {
  let headSha;
  let mergeAttempted = false;
  const checkEnforcement = config?.checkEnforcement ?? 'github-required';
  const checkSource = checkEnforcement === 'runner'
    ? 'Configured requiredChecks enforced by runner'
    : 'Configured requiredChecks plus GitHub-required checks';
  const recovery = 'Retain this PR and worktree. PM recovery must inspect the existing PR, revalidate gates and reconcile confirmed MERGED state; do not reselect the In Review issue or rerun implementation.';
  const checkAbort = () => { if (signal?.aborted) throw new Error(`Delivery canceled: ${signal.reason || 'aborted'}`); };
  try {
    checkAbort();
    validateDelivery(config, true);
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(prUrl);
    if (!match || match[1] !== config.repository) throw new Error('PR URL does not belong to configured repository');
    const gh = async (verb, ...args) => { checkAbort(); return exec('gh', ['pr', verb, prUrl, '--repo', config.repository, ...args], { cwd: worktree, env, signal }); };
    const local = () => verifyWorktree({ worktree, branch, overlays, excludedPaths, exec, signal, env });
    headSha = await local();
    validateApprovals(approvals, headSha);
    const view = async () => JSON.parse(await gh('view', '--json', fields));
    const validatePR = pr => {
      if (pr.url !== prUrl || pr.state !== 'OPEN' || pr.isDraft !== false || pr.baseRefName !== config.baseBranch
        || pr.headRefName !== branch || pr.headRefOid !== headSha || pr.isCrossRepository !== false
        || `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}` !== config.repository
        || pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN') throw new Error('PR identity, head or mergeability gate failed');
    };
    const checks = async () => {
      const all = JSON.parse(await gh('checks', '--json', 'name,bucket,state'));
      // Runner-only enforcement is an explicit project opt-in, never an error
      // fallback. Strict mode stays fail-closed on unavailable branch protection.
      const required = checkEnforcement === 'runner' ? []
        : JSON.parse(await gh('checks', '--required', '--json', 'name,bucket,state'));
      if (!Array.isArray(all) || !Array.isArray(required)
        || config.requiredChecks.some(name => !all.some(check => check.name === name)
          || all.filter(check => check.name === name).some(check => check.bucket !== 'pass'))
        || required.some(check => check.bucket !== 'pass')) throw new Error('Required checks missing or not passing');
    };
    validatePR(await view());
    await checks();
    // Fresh reads immediately before the single mutation; the server enforces protection.
    if (await local() !== headSha) throw new Error('Local head changed between reads');
    validateApprovals(approvals, headSha);
    await checks();
    validatePR(await view());
    checkAbort();
    mergeAttempted = true;
    await gh('merge', '--squash', '--match-head-commit', headSha);
    const merged = await view();
    if (merged.url !== prUrl || merged.state !== 'MERGED' || merged.headRefOid !== headSha || !SHA.test(merged.mergeCommit?.oid)) {
      throw new Error('GitHub did not confirm MERGED with an actual merge commit');
    }
    return { state: 'merged', reason: 'GitHub confirmed MERGED with an actual merge commit', checkEnforcement, checkSource, prUrl, headSha, mergeAttempted, mergeCommit: merged.mergeCommit.oid,
      commitUrl: `https://github.com/${config.repository}/commit/${merged.mergeCommit.oid}` };
  } catch (error) {
    return { state: 'blocked', reason: error.message, checkEnforcement, checkSource, prUrl, headSha, mergeAttempted, recovery };
  }
}
