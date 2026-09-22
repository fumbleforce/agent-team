// The standard every teammate log entry is held to: name the task, the step or file it touched, what happened, and the outcome.
// A bare line — "done", "ok", "all set" — names no step and no outcome, so it is refused whole wherever an agent's words enter
// the log: the task report, a handoff, a review verdict, or an engine's final summary. Exact bare lines only: a line that says
// more is judged by its reader, not by this list.
const NOTHING_SAID = new Set([
  'done', 'ok', 'okay', 'completed', 'complete', 'finished', 'finished it', 'did it', 'fixed it', 'all set', 'all done', 'looks good',
  'ready', 'ready for review', 'not needed', 'blocked', 'in progress', 'working on it', 'still working on it', 'wip', 'started',
  'picked up', 'took it', 'on it', 'handled', 'handled it', 'sorted', 'sorted it', 'sorted it out', 'no change', 'no changes',
  'nothing to do', 'nothing to report', 'pass', 'approved', 'approve', 'lgtm', 'ship it',
]);
export const saysNothing = (summary: string): boolean => NOTHING_SAID.has(summary.trim().toLowerCase().replace(/[.!?…]+$/, '').replace(/\s+/g, ' '));

export const BARE_REPORT = 'This bare line cannot be logged: it names no step and no outcome. Say what was done — the task, the concrete step or file it touched, what happened and how it ended.';
export const BARE_VERDICT = 'This bare line cannot be logged: it names no check and no outcome. Say what you looked at, what you found, and how it ended.';
