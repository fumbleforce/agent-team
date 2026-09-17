import * as fs from 'node:fs';
import path from 'node:path';
import { parseEventLine } from '../adapters/engine/index.mjs';

export const RUN_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z-[a-f0-9]{8}$/;
export const clip = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

export function tail(file, bytes = 262144) {

  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// Steps a dashboard can show: what each member said, which tools were called, and whether a
// subagent did it. Each engine adapter parses its own event shapes; the core only knows the
// runner's own markers and the chat delta stream.
export function eventSteps(text, limit = 40, worktree = null, { results = false, handoffs = {} } = {}) {
  const local = value => worktree ? String(value).split(`${worktree}/`).join('') : String(value);
  const steps = [];
  // Subagent events carry the delegation call's id; that call named the role, so steps are attributed by member.
  // Callers streaming batch by batch pass the same handoffs map so attribution survives across batches.
  const members = {};
  const context = { results, handoffs, usage: null, engineResult: null, tokens: 0, costUsd: null,
    push(scope, kind, value, member = null) {
      steps.push({ scope, kind, member, text: kind === 'delta' ? String(value) : clip(local(value), kind === 'text' ? 300 : kind === 'result' ? 240 : 200) });
      if (member) members[member] = (members[member] ?? 0) + 1;
    } };
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (results && event.type === 'chat_delta' && typeof event.text === 'string') { context.push('coordinator', 'delta', event.text, null); continue; }
    if (typeof event.type === 'string' && event.type.startsWith('runner.')) continue;
    parseEventLine(event, context);
  }
  const last = steps.at(-1);
  return { steps: steps.slice(-limit), usage: context.usage, engineResult: context.engineResult, tokens: context.tokens, costUsd: context.costUsd, members, active: last ? last.member ?? 'team-coordinator' : null };
}

export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

export function runSummary(project, dir, id) {
  const journal = readJson(path.join(dir, 'journal.json'));
  if (!journal) return { project, id, state: 'unreadable' };
  // Running journals carry the pinned issue only in options; the final issue is recorded at the end.
  return { project, id, state: journal.state, engine: journal.engine ?? 'unknown', billing: journal.billing ?? null, memory: journal.memory ?? null, issue: journal.issue ?? journal.options?.issue ?? null,
    ideation: journal.options?.ideate === true, worktree: journal.worktree ?? null, prUrl: journal.prUrl ?? null,
    delivery: journal.delivery?.state ?? null, startedAt: journal.startedAt, finishedAt: journal.finishedAt ?? null,
    baseCommit: journal.baseCommit ? journal.baseCommit.slice(0, 8) : null, summary: clip(journal.summary ?? journal.error ?? '', 400),
    proposals: Array.isArray(journal.proposals) ? journal.proposals.map(p => p.title) : undefined };
}


// Everything a remote dashboard needs about one run, read from the runner's run directory.
export function runEvidence(project, dir, id, { stepLimit = 300 } = {}) {
  const run = runSummary(project, dir, id);
  const parsed = eventSteps(tail(path.join(dir, 'events.jsonl'), 1048576), stepLimit, run.worktree);
  let summary = ''; try { summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').slice(0, 20000); } catch { /* not written yet */ }
  return { run, steps: parsed.steps, members: parsed.members, active: run.ideation ? 'team-ideation' : parsed.active, usage: parsed.usage, engineResult: parsed.engineResult, tokens: parsed.tokens, summary, stderr: tail(path.join(dir, 'stderr.log'), 8192) };
}

// A member's recent steps across the latest local runs, newest first.
export function memberActivity({ projects, role, runLimit = 8 }) {
  const activity = [];
  for (const [project, checkout] of Object.entries(projects)) {
    const runsDir = path.join(checkout, '.agent-team', 'runs');
    let ids = [];
    try { ids = fs.readdirSync(runsDir).filter(id => RUN_ID.test(id)).sort().reverse(); } catch { continue; }
    for (const id of ids.slice(0, runLimit)) {
      const dir = path.join(runsDir, id);
      const run = runSummary(project, dir, id);
      const parsed = eventSteps(tail(path.join(dir, 'events.jsonl'), 1048576), 400, run.worktree);
      const mine = parsed.steps.filter(step => role === 'team-coordinator' ? !step.member : step.member === role);
      if (role === 'team-ideation' ? run.ideation : mine.length) activity.push({ run, steps: (role === 'team-ideation' ? parsed.steps : mine).slice(-12), count: role === 'team-ideation' ? parsed.steps.length : mine.length });
    }
  }
  activity.sort((a, b) => (b.run.startedAt ?? '').localeCompare(a.run.startedAt ?? ''));
  return activity;
}
