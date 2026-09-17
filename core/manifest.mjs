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

// Sections the owner may override from the dashboard. Everything about the repository itself
// (scm, delivery gates, instructions, charter) stays in the committed manifest.
export const OVERRIDABLE_SECTIONS = ['tracker', 'engine', 'worker', 'memory', 'pm', 'team', 'ideation'];
// Keys inside overridable sections that still identify the repository and stay read-only.
const PROTECTED_KEYS = { tracker: ['kind'], engine: [], worker: [], memory: [], pm: [], team: [], ideation: [] };
// Keys where null is itself a meaningful value rather than "remove the repository's key".
const NULLABLE_KEYS = { team: ['roles'] };

// Checks the shape of a dashboard override document: allowlisted sections only, each a plain
// object, nested values limited to strings, numbers, booleans, null and string arrays.
export function validateOverrides(overrides) {
  if (overrides === null || overrides === undefined) return {};
  if (!plain(overrides)) throw new Error('Overrides must be an object of sections');
  const result = {};
  for (const [section, values] of Object.entries(overrides)) {
    if (!OVERRIDABLE_SECTIONS.includes(section)) throw new Error(`Section ${section} cannot be overridden from the dashboard`);
    if (!plain(values)) throw new Error(`Override section ${section} must be an object`);
    const clean = {};
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`Invalid override key ${section}.${key}`);
      if (PROTECTED_KEYS[section].includes(key)) throw new Error(`${section}.${key} cannot be overridden from the dashboard`);
      const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value);
      const list = Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string');
      if (!scalar && !list) throw new Error(`Invalid override value ${section}.${key}`);
      if (typeof value === 'string' && value.length > 2000) throw new Error(`Override ${section}.${key} is too long`);
      clean[key] = value;
    }
    if (Object.keys(clean).length) result[section] = clean;
  }
  return result;
}

// Applies dashboard overrides on top of a repository manifest of either version. The result is a
// version 2 document; a null override value removes the repository's key so the default applies.
export function applyOverrides(raw, overrides) {
  const clean = validateOverrides(overrides);
  if (!Object.keys(clean).length) return raw;
  if (!plain(raw) || ![1, 2].includes(raw.version)) throw new Error('Invalid .agent-team.json: version 1 or 2 required');
  const config = structuredClone(upgrade(raw));
  for (const [section, values] of Object.entries(clean)) {
    const merged = { ...(plain(config[section]) ? config[section] : {}) };
    for (const [key, value] of Object.entries(values)) { if (value === null && !NULLABLE_KEYS[section]?.includes(key)) delete merged[key]; else merged[key] = value; }
    config[section] = merged;
  }
  return config;
}

// Normalizes a manifest of either version into the version 2 shape with every default filled in,
// after applying any dashboard overrides. Values are validated for shape; provider adapters
// validate their own sections.
export function normalizeManifest(raw, overrides = null) {
  if (!plain(raw) || ![1, 2].includes(raw.version)) throw new Error('Invalid .agent-team.json: version 1 or 2 required');
  const config = upgrade(applyOverrides(raw, overrides));
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
