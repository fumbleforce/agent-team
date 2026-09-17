import { scmAdapter, DEFAULT_SCM } from '../adapters/scm/index.mjs';
import { trackerAdapter, DEFAULT_TRACKER } from '../adapters/tracker/index.mjs';
import { validateEngine, validateBilling, DEFAULT_ENGINE } from '../adapters/engine/index.mjs';
import { LAUNCHER_KINDS, DEFAULT_LAUNCHER } from '../adapters/launcher/index.mjs';

// Roles the coordinator delegates to by default; the full persona pipeline stays available.
export const DEFAULT_ROLES = ['team-dev', 'team-tester'];
export const ALL_ROLES = ['team-pm', 'team-ux', 'team-dev', 'team-tester', 'team-reviewer'];
// Approvals the delivery gate demands, derived from the delegated roles.
const APPROVALS = { 'team-tester': 'tester', 'team-reviewer': 'reviewer', 'team-pm': 'pm' };
export const AUTONOMY_LEVELS = ['observe', 'suggest', 'act'];

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }

// A version 1 manifest is a version 2 manifest with the first provider of each kind. Its team
// roles are null: every shared subagent is delegated to and the delivery gate demands the full
// set of approvals, exactly as before roles became configurable.
function upgrade(config) {
  if (config.version === 2) return config;
  const { workspaceId, workspaceUrl, teamId, projectId, projectUrl, readyLabel, ownerInboxIssue, ...rest } = config;
  const delivery = plain(config.delivery) ? config.delivery : undefined;
  return { ...rest, version: 2,
    scm: { kind: DEFAULT_SCM, ...(delivery?.repository ? { repository: delivery.repository } : {}), baseBranch: delivery?.baseBranch ?? 'main' },
    tracker: { kind: DEFAULT_TRACKER, workspaceId, workspaceUrl, teamId, projectId, projectUrl, readyLabel, ...(ownerInboxIssue ? { ownerInboxIssue } : {}) },
    team: { roles: null } };
}

// Normalizes a manifest of either version into the version 2 shape with every default filled in.
// Values are validated for shape; provider adapters validate their own sections.
export function normalizeManifest(raw) {
  if (!plain(raw) || ![1, 2].includes(raw.version)) throw new Error('Invalid .agent-team.json: version 1 or 2 required');
  const config = upgrade(raw);
  for (const key of ['name']) if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Invalid .agent-team.json: ${key} is required`);
  if (!Array.isArray(config.instructions)) throw new Error('Invalid .agent-team.json: instructions must be an array');
  if (config.queueProjectId !== undefined && !ID.test(String(config.queueProjectId))) throw new Error('Invalid .agent-team.json: queueProjectId');

  const scm = { kind: DEFAULT_SCM, baseBranch: 'main', branchPrefix: 'agents/', ...(plain(config.scm) ? config.scm : {}) };
  scmAdapter(scm.kind);
  if (typeof scm.branchPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*\/$/.test(scm.branchPrefix)) throw new Error('Invalid .agent-team.json: scm.branchPrefix must end with /');
  if (scm.repository !== undefined && !scmAdapter(scm.kind).validateRepository(scm.repository)) throw new Error('Invalid .agent-team.json: scm.repository');

  const tracker = { kind: DEFAULT_TRACKER, ...(plain(config.tracker) ? config.tracker : {}) };
  trackerAdapter(tracker.kind).validateManifest(tracker);

  const engine = { default: DEFAULT_ENGINE, ...(plain(config.engine) ? config.engine : {}) };
  validateEngine(engine.default);
  engine.billing = validateBilling(engine.default, engine.billing);
  if (engine.model !== undefined && (typeof engine.model !== 'string' || !engine.model.trim() || engine.model.startsWith('-'))) throw new Error('Invalid .agent-team.json: engine.model');

  const worker = { launcher: DEFAULT_LAUNCHER, ...(plain(config.worker) ? config.worker : {}) };
  if (!LAUNCHER_KINDS.includes(worker.launcher)) throw new Error(`Invalid .agent-team.json: worker.launcher must be one of ${LAUNCHER_KINDS.join(', ')}`);
  for (const key of ['image', 'ami', 'instanceType', 'sizeHint', 'subnetId', 'securityGroupId', 'instanceProfile', 'region']) {
    if (worker[key] !== undefined && (typeof worker[key] !== 'string' || !worker[key].trim())) throw new Error(`Invalid .agent-team.json: worker.${key}`);
  }

  const memory = { injectCapTokens: 4000, ...(plain(config.memory) ? config.memory : {}) };
  if (!Number.isInteger(memory.injectCapTokens) || memory.injectCapTokens < 0 || memory.injectCapTokens > 60000) throw new Error('Invalid .agent-team.json: memory.injectCapTokens');

  const pm = { autonomy: 'suggest', dailyCapUsd: 20, ...(plain(config.pm) ? config.pm : {}) };
  if (!AUTONOMY_LEVELS.includes(pm.autonomy)) throw new Error(`Invalid .agent-team.json: pm.autonomy must be one of ${AUTONOMY_LEVELS.join(', ')}`);
  if (!Number.isFinite(pm.dailyCapUsd) || pm.dailyCapUsd < 0) throw new Error('Invalid .agent-team.json: pm.dailyCapUsd');

  const team = { roles: DEFAULT_ROLES, ...(plain(config.team) ? config.team : {}) };
  if (team.roles !== null && (!Array.isArray(team.roles) || !team.roles.length || team.roles.some(role => !ALL_ROLES.includes(role)) || new Set(team.roles).size !== team.roles.length)) throw new Error(`Invalid .agent-team.json: team.roles must list distinct roles from ${ALL_ROLES.join(', ')}`);

  // The delivery section keeps repository and baseBranch as the gate reads them; they mirror scm.
  // A version 1 delivery section without baseBranch keeps building on the worker's HEAD.
  const delivery = plain(config.delivery) ? { ...config.delivery } : undefined;
  if (delivery) {
    delivery.repository ??= scm.repository;
    if (raw.version === 2) delivery.baseBranch ??= scm.baseBranch;
    if (delivery.repository !== scm.repository || (delivery.baseBranch !== undefined && delivery.baseBranch !== scm.baseBranch)) throw new Error('Invalid .agent-team.json: delivery.repository/baseBranch must match scm');
  }
  return { ...config, version: 2, scm, tracker, engine, worker, memory, pm, team, ...(delivery ? { delivery } : {}) };
}

// Approval roles delivery must see, in the order the gate checks them.
export function approvalRoles(manifest) {
  if (manifest.team.roles === null) return ['tester', 'reviewer', 'pm'];
  return manifest.team.roles.map(role => APPROVALS[role]).filter(Boolean);
}

// Tracker fields under their neutral names for prompts and clients that predate the sections.
export function flatTracker(manifest) {
  return { ...manifest.tracker, name: manifest.name, ideation: manifest.ideation, delivery: manifest.delivery, queueProjectId: manifest.queueProjectId };
}
