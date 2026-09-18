import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROSTER } from './roster.mjs';
import { PACKAGE_DIR, blueprintDir } from './blueprint.mjs';

// Teams are data the coordinator stores and the dashboard edits: a document naming the roles,
// their personas and their prompts. The repository stays the safety ceiling: a stored team can
// rename, re-voice and re-prompt roles and add subagents, but every role's permissions come from
// the committed roles file (or a fixed floor for new subagents) and a stored team can only
// tighten them. Directory blueprints (the toolkit root and teams/<name>) seed the store.
//
//   { id, name, description, roster: { role: { name, title, voice } }, defaultRoles: [role],
//     agents: { role: { mode, description, prompt, steps, deny: [edit|bash|tracker] } } }
export const ROLE = /^team-[a-z]+$/;
export const TEAM_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const REQUIRED_ROLES = ['team-coordinator', 'team-pm', 'team-owner'];
export const TIGHTENINGS = ['edit', 'bash', 'tracker'];
// What a subagent the repository does not know may do at most.
const SUBAGENT_FLOOR = { task: 'deny', question: 'deny', 'tracker_*': 'deny' };

export class TeamError extends Error { constructor(message) { super(message); this.status = 400; } }
const reject = message => { throw new TeamError(message); };
const short = (value, name, max) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) reject(`${name} is required (at most ${max} characters)`); return value.trim(); };

export function validateTeam(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('A team is an object');
  const id = short(input.id, 'id', 64); if (!TEAM_ID.test(id)) reject('id must be lowercase letters, digits and dashes');
  const name = short(input.name, 'name', 80);
  const description = !input.description ? '' : short(input.description, 'description', 400);
  if (!input.agents || typeof input.agents !== 'object' || Array.isArray(input.agents)) reject('agents must map roles to definitions');
  if (!input.roster || typeof input.roster !== 'object' || Array.isArray(input.roster)) reject('roster must map roles to members');
  const agents = {}; const roster = {};
  for (const [role, agent] of Object.entries(input.agents)) {
    if (agent === undefined || agent === null) continue;
    if (!ROLE.test(role)) reject(`role ${role} must look like team-<word>`);
    if (!agent || typeof agent !== 'object') reject(`agent ${role} must be an object`);
    if (!['primary', 'subagent'].includes(agent.mode)) reject(`agent ${role} mode must be primary or subagent`);
    const entry = { mode: agent.mode, description: short(agent.description ?? role, `${role} description`, 200), prompt: short(agent.prompt, `${role} prompt`, 40_000) };
    if (agent.steps !== undefined) { if (!Number.isInteger(agent.steps) || agent.steps < 1 || agent.steps > 500) reject(`${role} steps must be 1..500`); entry.steps = agent.steps; }
    const deny = agent.deny ?? [];
    if (!Array.isArray(deny) || deny.some(item => !TIGHTENINGS.includes(item))) reject(`${role} deny must list ${TIGHTENINGS.join(', ')}`);
    entry.deny = [...new Set(deny)];
    agents[role] = entry;
  }
  for (const role of REQUIRED_ROLES) if (!agents[role]) reject(`agents must include ${role}`);
  if (agents['team-coordinator'].mode !== 'primary' || agents['team-owner'].mode !== 'primary') reject('team-coordinator and team-owner are primary roles');
  for (const [role, member] of Object.entries(input.roster)) {
    if (member === undefined || member === null) continue;
    if (!ROLE.test(role)) reject(`roster role ${role} must look like team-<word>`);
    roster[role] = { name: short(member?.name, `${role} name`, 80), title: short(member?.title, `${role} title`, 80), voice: short(member?.voice, `${role} voice`, 600) };
  }
  for (const role of Object.keys(agents)) if (!roster[role]) reject(`roster must include ${role}`);
  const subagents = Object.entries(agents).filter(([, agent]) => agent.mode === 'subagent').map(([role]) => role);
  const defaultRoles = input.defaultRoles === undefined || input.defaultRoles === null ? subagents.filter(role => role !== 'team-pm') : input.defaultRoles;
  if (!Array.isArray(defaultRoles) || defaultRoles.some(role => !subagents.includes(role)) || new Set(defaultRoles).size !== defaultRoles.length) reject('defaultRoles must list distinct subagent roles');
  return { id, name, description, roster, defaultRoles, agents };
}

export function subagentRoles(team) { return Object.entries(team.agents).filter(([, agent]) => agent.mode === 'subagent').map(([role]) => role); }

// Builds a team document from a directory blueprint (roles.json, agents/*.md, roster.json).
export function teamFromDirectory(dir, { id = path.basename(dir), name = null, description = '', defaultRoles = null } = {}) {
  const roles = JSON.parse(readFileSync(path.join(dir, 'roles.json'), 'utf8'));
  const rosterFile = path.join(dir, 'roster.json');
  const roster = existsSync(rosterFile) ? JSON.parse(readFileSync(rosterFile, 'utf8')) : DEFAULT_ROSTER;
  const agents = {};
  for (const [role, agent] of Object.entries(roles.agent ?? {})) {
    const match = /^\{file:\.\/(agents\/[A-Za-z0-9_-]+\.md)\}$/.exec(agent.prompt ?? '');
    const prompt = match ? readFileSync(path.join(dir, match[1]), 'utf8') : agent.prompt;
    agents[role] = { mode: agent.mode, description: agent.description ?? role, prompt, ...(agent.steps ? { steps: agent.steps } : {}), deny: [] };
  }
  return validateTeam({ id, name: name ?? (id === 'default' ? 'Delivery team' : id.replace(/-/g, ' ')), description, roster: Object.fromEntries(Object.keys(agents).map(role => [role, roster[role]]).filter(([, member]) => member)), defaultRoles: defaultRoles ?? roles.team?.defaultRoles ?? null, agents });
}

// Every blueprint the toolkit ships: its root as `default`, then teams/<name>.
export function shippedTeams(packageDir = PACKAGE_DIR, env = process.env) {
  const teams = [teamFromDirectory(blueprintDir(packageDir, env), { id: 'default', name: 'Delivery team', description: 'Software delivery: PM, UX, developer, tester, reviewer', defaultRoles: ['team-dev', 'team-tester'] })];
  const dir = path.join(packageDir, 'teams');
  if (existsSync(dir)) for (const entry of readdirSync(dir).sort()) {
    const candidate = path.join(dir, entry);
    if (TEAM_ID.test(entry) && entry !== 'default' && statSync(candidate).isDirectory() && existsSync(path.join(candidate, 'roles.json'))) teams.push(teamFromDirectory(candidate, { id: entry }));
  }
  return teams;
}

// The shared configuration the runner and engines consume, with permissions taken from the
// committed roles file (the ceiling) and only tightened by the stored team.
export function materialize(team, ceiling, { roles = null } = {}) {
  const config = { agent: {}, instructions: ceiling.instructions ?? [], team: { id: team.id, defaultRoles: team.defaultRoles }, roster: team.roster };
  for (const [role, agent] of Object.entries(team.agents)) {
    const committed = ceiling.agent?.[role];
    if (agent.mode === 'primary' && !committed) reject(`primary role ${role} is not in the committed roles file`);
    if (committed && committed.mode !== agent.mode) reject(`role ${role} is ${committed.mode} in the committed roles file`);
    const permission = structuredClone(committed?.permission ?? SUBAGENT_FLOOR);
    if (!committed) { permission.task = 'deny'; permission.question = 'deny'; permission['tracker_*'] = 'deny'; }
    for (const item of agent.deny) permission[item === 'tracker' ? 'tracker_*' : item] = 'deny';
    if (roles && agent.mode === 'subagent' && !roles.includes(role)) continue;
    config.agent[role] = { mode: agent.mode, description: agent.description, prompt: agent.prompt, ...(agent.steps ?? committed?.steps ? { steps: agent.steps ?? committed.steps } : {}), permission };
  }
  if (roles) for (const role of roles) if (!config.agent[role]) reject(`team role ${role} is not a subagent of team ${team.id}`);
  return config;
}
