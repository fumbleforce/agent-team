import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A team blueprint is a directory holding the roles file, the persona prompts and the roster
// that one control plane runs with:
//   roles.json          the shared agent configuration (same format as the toolkit's own)
//   roster.json         { role: { name, title, voice } } shown in prompts and the dashboard
//   agents/<role>.md    one prompt per role, referenced from roles.json as {file:./agents/<role>.md}
//   portraits/<role>.webp   optional dashboard portraits
// AGENT_TEAM_BLUEPRINT selects one: a name under the toolkit's teams/ directory or an absolute
// path. Unset, the toolkit's own delivery team (roles.json, agents/, portraits/) is the
// blueprint. Every blueprint keeps team-coordinator, team-pm and team-owner: the runner, the
// resident PM and owner chat address them by role name; their names and voices are free.
export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REQUIRED_ROLES = ['team-coordinator', 'team-pm', 'team-owner'];
const NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function blueprintDir(packageDir = PACKAGE_DIR, env = process.env) {
  const selected = env.AGENT_TEAM_BLUEPRINT;
  if (!selected) return packageDir;
  const dir = path.isAbsolute(selected) ? selected : NAME.test(selected) ? path.join(packageDir, 'teams', selected) : null;
  if (!dir || !existsSync(path.join(dir, 'roles.json'))) throw new Error(`Team blueprint ${selected} has no roles.json`);
  return dir;
}

// The blueprint's file for a relative name, falling back to the toolkit's own when the
// blueprint omits it (portraits, shared instructions).
export function blueprintFile(relative, { packageDir = PACKAGE_DIR, env = process.env, fallback = true } = {}) {
  const own = path.join(blueprintDir(packageDir, env), relative);
  if (existsSync(own) && statSync(own).isFile()) return own;
  const shared = path.join(packageDir, relative);
  return fallback && existsSync(shared) && statSync(shared).isFile() ? shared : null;
}

export function loadRolesFile(packageDir = PACKAGE_DIR, env = process.env) {
  const config = JSON.parse(readFileSync(path.join(blueprintDir(packageDir, env), 'roles.json'), 'utf8'));
  if (!config?.agent || typeof config.agent !== 'object') throw new Error('Team blueprint roles.json requires an agent map');
  if (!config.agent['team-coordinator']) throw new Error('Team blueprint roles.json requires agent.team-coordinator');
  return config;
}

// Subagent roles in declaration order; the manifest's team.roles chooses among them.
export function subagentRoles(packageDir = PACKAGE_DIR, env = process.env) {
  return Object.entries(loadRolesFile(packageDir, env).agent).filter(([, agent]) => agent.mode === 'subagent').map(([name]) => name);
}

// The roster the blueprint ships, validated to the shape prompts and the dashboard rely on.
export function loadRoster(fallback, packageDir = PACKAGE_DIR, env = process.env) {
  const file = blueprintFile('roster.json', { packageDir, env, fallback: false });
  if (!file) return fallback;
  const roster = JSON.parse(readFileSync(file, 'utf8'));
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) throw new Error('Team blueprint roster.json must map roles to members');
  for (const [role, member] of Object.entries(roster)) {
    if (!/^team-[a-z]+$/.test(role)) throw new Error(`Team blueprint roster role ${role} must look like team-<word>`);
    for (const key of ['name', 'title', 'voice']) if (typeof member?.[key] !== 'string' || !member[key].trim() || member[key].length > (key === 'voice' ? 600 : 80)) throw new Error(`Team blueprint roster ${role}.${key} is required`);
  }
  for (const role of REQUIRED_ROLES) if (!roster[role]) throw new Error(`Team blueprint roster.json requires ${role}`);
  return roster;
}
