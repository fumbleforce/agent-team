import * as fs from 'node:fs';
import { claudeSystemPrompt } from './claude.mjs';

// Engine adapter for the OpenAI Codex CLI (`codex exec`). Codex reads AGENTS.md from the worktree
// and has no system-prompt flag, so the role text and memory are prepended to the prompt.
// `--full-auto` runs in the workspace-write sandbox without approval prompts; Codex offers no
// prefix deny list, so forbidden commands are stated in the prompt and enforced by isolation.
export const NAME = 'codex';
export const BIN = 'codex';
export const BILLING_MODES = ['api', 'subscription'];
export const DEFAULT_BILLING = 'api';
export const DEFAULT_MODEL = undefined;
export const NEEDS_SYSTEM_PROMPT_FILE = false;
export const API_KEY_VARIABLE = 'OPENAI_API_KEY';
export const KEYED_BILLING = ['api'];
export const BILLING_DESCRIPTIONS = { api: 'an OpenAI API key, metered', subscription: 'the ChatGPT account logged in on the worker' };

export function rateLimitPolicy(billing = DEFAULT_BILLING) { return billing === 'subscription' ? 'quarantine' : 'job'; }

export function environment(env, { billing = DEFAULT_BILLING } = {}) {
  const filtered = { ...env };
  if (billing === 'subscription') delete filtered.OPENAI_API_KEY;
  return filtered;
}

export function preflight({ command, cwd, env, billing = DEFAULT_BILLING }) {
  if (billing === 'api' && !env.OPENAI_API_KEY) throw new Error('Codex api billing requires OPENAI_API_KEY in the worker environment');
  return { codex: command(BIN, ['--version'], cwd, env), billing };
}

export function systemPrompt({ shared, role, instructions, memory }) {
  return claudeSystemPrompt({ shared: { ...shared, agent: Object.fromEntries(Object.entries(shared.agent).filter(([, agent]) => agent.mode !== 'subagent').concat([[role, shared.agent[role]]])) }, role, instructions, memory });
}

export function invocation({ prompt, model, systemPromptText = '', worktree, denied = [] }) {
  const args = ['exec', '--json', '--full-auto', '--cd', worktree, '--skip-git-repo-check'];
  if (model) args.push('--model', model);
  const rules = denied.length ? `\n\nForbidden shell commands (never run them, the runner owns delivery): ${denied.join('; ')}.` : '';
  args.push(`${systemPromptText ? `${systemPromptText}\n\n---\n\n` : ''}${prompt}${rules}`);
  return { bin: BIN, args };
}

const LIMIT = /rate.?limit|usage limit|too many requests|\b429\b|insufficient_quota/i;

export function stopReason({ eventsFile, stderrFile }) {
  const tail = file => { try { return fs.readFileSync(file, 'utf8').slice(-65536); } catch { return ''; } };
  for (const line of tail(eventsFile).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'error' && LIMIT.test(String(event.message ?? ''))) return 'rate-limited';
    if (event?.type === 'turn.failed' && LIMIT.test(JSON.stringify(event.error ?? ''))) return 'rate-limited';
  }
  return LIMIT.test(tail(stderrFile)) ? 'rate-limited' : null;
}

// JSONL events: item.completed carries agent messages, command executions and file changes;
// turn.completed carries token usage.
export function parseEvent(event, context) {
  const { push, results } = context;
  if (event.type === 'item.completed' && event.item) {
    const item = event.item;
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) push('coordinator', 'text', item.text);
    else if (item.type === 'command_execution') {
      push('coordinator', 'tool', `shell: ${item.command ?? ''}`);
      if (results && typeof item.aggregated_output === 'string' && item.aggregated_output.trim()) push('coordinator', 'result', item.aggregated_output);
    } else if (item.type === 'file_change') push('coordinator', 'tool', `edit: ${(item.changes ?? []).map(change => change.path).filter(Boolean).join(', ')}`);
    else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) push('coordinator', 'text', item.text);
    return true;
  }
  if (event.type === 'turn.completed') {
    const usage = event.usage ?? {};
    context.tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    return true;
  }
  if (['thread.started', 'turn.started', 'item.started', 'item.updated'].includes(event.type)) return true;
  return false;
}

export function ask() {
  return Promise.reject(new Error('The codex engine does not yet support bounded question sessions'));
}
