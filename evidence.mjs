import * as fs from 'node:fs';
import path from 'node:path';

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

// One line per model step for either engine: what the coordinator said or which tool it
// called, and whether a subagent did it. Claude emits assistant/result/rate_limit events;
// OpenCode emits text/tool_use/step_finish parts.
export function eventSteps(text, limit = 40, worktree = null, { results = false, handoffs = {} } = {}) {
  const local = value => worktree ? String(value).split(`${worktree}/`).join('') : String(value);
  const steps = []; let usage = null; let engineResult = null; let tokens = 0;
  // Subagent events carry the Agent call's id; that call named the role, so steps are attributed by member.
  // Callers streaming batch by batch pass the same handoffs map so attribution survives across batches.
  const members = {};
  const push = (scope, kind, value, member = null) => {
    steps.push({ scope, kind, member, text: kind === 'delta' ? String(value) : clip(local(value), kind === 'text' ? 300 : kind === 'result' ? 240 : 200) });
    if (member) members[member] = (members[member] ?? 0) + 1;
  };
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const scope = event.parent_tool_use_id ? 'subagent' : 'coordinator';
    const member = event.parent_tool_use_id ? handoffs[event.parent_tool_use_id] ?? 'subagent' : null;
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) push(scope, 'text', block.text, member);
        else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          if (block.name === 'Agent' && typeof input.subagent_type === 'string' && block.id) handoffs[block.id] = input.subagent_type;
          const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.prompt ?? input.query ?? '';
          push(scope, 'tool', `${block.name}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`, member);
        }
      }
    } else if (results && event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type !== 'tool_result') continue;
        const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join(' ') : '';
        if (content.trim()) push(scope, 'result', content, member);
      }
    } else if (results && event.type === 'chat_delta' && typeof event.text === 'string') push('coordinator', 'delta', event.text, null);
    else if (event.type === 'rate_limit_event' && event.rate_limit_info) {
      const windows = event.rate_limit_info.unifiedWindows ?? {};
      usage = { status: event.rate_limit_info.status, fiveHour: windows.five_hour ?? null, sevenDay: windows.seven_day ?? null };
    } else if (event.type === 'result') {
      engineResult = { subtype: event.subtype, isError: event.is_error === true, durationMs: event.duration_ms, turns: event.num_turns };
    } else if (event.type === 'text' && event.part?.text?.trim()) push('coordinator', 'text', event.part.text);
    else if (event.type === 'tool_use' && event.part) {
      const input = event.part.state?.input ?? {};
      const detail = input.description ?? input.command ?? input.filePath ?? input.pattern ?? input.prompt ?? '';
      push(event.part.tool === 'task' ? 'subagent' : 'coordinator', 'tool', `${event.part.tool}${input.subagent_type ? ` → ${input.subagent_type}` : ''}${detail ? `: ${detail}` : ''}`, event.part.tool === 'task' ? input.subagent_type ?? 'subagent' : null);
    } else if (event.type === 'step_finish' && Number.isFinite(event.part?.tokens?.total)) tokens += event.part.tokens.total;
  }
  const last = steps.at(-1);
  return { steps: steps.slice(-limit), usage, engineResult, tokens, members, active: last ? last.member ?? 'team-coordinator' : null };
}

export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

export function runSummary(project, dir, id) {
  const journal = readJson(path.join(dir, 'journal.json'));
  if (!journal) return { project, id, state: 'unreadable' };
  // Running journals carry the pinned issue only in options; the final issue is recorded at the end.
  return { project, id, state: journal.state, engine: journal.engine ?? 'opencode', issue: journal.issue ?? journal.options?.issue ?? null,
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
