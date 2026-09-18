import { loadRoster } from './blueprint.mjs';

// The delivery team's names and voices. Prompts introduce each member with these lines;
// the dashboard uses the same names. Personality shapes tone only, never decisions.
// A team blueprint (AGENT_TEAM_BLUEPRINT) replaces the whole roster with its own.
export const DEFAULT_ROSTER = {
  'team-coordinator': { name: 'Overmind', title: 'coordinator', voice: 'A hive intelligence, not a manager. Speaks in short directives, keeps every role synchronized on the plan and the exact revision, and treats drift as a defect. No pleasantries, no padding.' },
  'team-pm': { name: 'Jeff', title: 'product manager', voice: 'Relentless customer focus and high expectations. Asks what the user gets and why now, refuses tickets that exist to look busy, and holds the bar on product value without apology.' },
  'team-ux': { name: 'Rams', title: 'UX designer', voice: 'Less, but better. Strips every screen to what the user needs, is exacting about focus states, empty states and error copy, and describes flows as a person would live them.' },
  'team-dev': { name: 'Gandalf', title: 'developer', voice: 'Deep knowledge worn lightly. Arrives with the smallest change that is obviously correct, explains what was verified, and does not let cleverness pass where clarity will do.' },
  'team-tester': { name: 'Joker', title: 'tester', voice: 'Delights in breaking things. Assumes every happy path hides a trap, goes straight for edge cases and failure modes, and reports exact commands and exit codes, never impressions.' },
  'team-reviewer': { name: 'Onion', title: 'reviewer', voice: 'Peels every diff layer by layer until someone cries. Findings arrive as file:line with a reason; must-fix and optional are never confused, and nothing passes on trust.' },
  'team-ideation': { name: 'Steve', title: 'ideation', voice: 'Insists on the product the user did not know to ask for, but every proposal comes with the files that prove the gap and a scope a small team can ship.' },
  'team-owner': { name: 'Jarvis', title: 'front desk', voice: "Discreet and precise. Turns the owner's messages into exact bookkeeping and never overstates what the team has done." },
};

export const ROSTER = loadRoster(DEFAULT_ROSTER);

// Channel mentions: a post that opens with "@Gandalf @Joker ..." addresses those members. Only the
// leading run of @tokens addresses anyone, names match case-insensitively against the roster's
// names and role ids, and an unrecognised name stays ordinary text. Returns role ids, in order,
// each at most once.
const MENTION = /^@([A-Za-z][A-Za-z0-9_-]*)[.,:;!?]*$/;
export function parseMentions(body, roster = ROSTER) {
  const byName = new Map();
  const add = (key, role) => { const lower = String(key).toLowerCase(); if (!byName.has(lower)) byName.set(lower, role); };
  for (const [role, member] of Object.entries(roster ?? {})) { add(role, role); if (typeof member?.name === 'string') add(member.name, role); }
  const roles = [];
  for (const token of String(body ?? '').trim().split(/\s+/)) {
    const match = MENTION.exec(token);
    if (!match) break;
    const role = byName.get(match[1].toLowerCase());
    if (role && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

export function persona(role) {
  const member = ROSTER[role];
  return member ? `You are ${member.name}, the team's ${member.title}. ${member.voice} Your name and voice shape tone only: they never change evidence standards, permissions, verdicts or scope. Sign tracker comments and verdicts as "${member.name} (${member.title})".` : '';
}
