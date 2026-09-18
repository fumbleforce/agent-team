import * as fs from 'node:fs';
import { claudeSystemPrompt } from './claude.mjs';

// Engine adapter for the Cursor headless CLI (`agent`). The CLI has no system-prompt flag, so the
// role text, project instructions and memory are prepended to the prompt on stdin. `--force`
// auto-approves tool use: there is no external permission hook, so the worker's isolation boundary
// (container or disposable host) is the safety mechanism, and the worker image should ship a
// ~/.cursor/cli-config.json deny list for the commands the SCM adapter marks as forbidden.
export const NAME = 'cursor';
export const BIN = 'agent';
export const BILLING_MODES = ['api'];
export const DEFAULT_BILLING = 'api';
export const DEFAULT_MODEL = undefined;
export const NEEDS_SYSTEM_PROMPT_FILE = false;
export const API_KEY_VARIABLE = 'CURSOR_API_KEY';
export const KEYED_BILLING = ['api'];
export const BILLING_DESCRIPTIONS = { api: 'a Cursor API key' };

export function rateLimitPolicy() { return 'job'; }

export function environment(env) {
  const filtered = { ...env };
  for (const key of Object.keys(filtered)) if (/^CURSOR_/.test(key) && key !== 'CURSOR_API_KEY') delete filtered[key];
  return filtered;
}

export function preflight({ command, cwd, env }) {
  if (!env.CURSOR_API_KEY) throw new Error('Cursor engine requires CURSOR_API_KEY in the worker environment');
  return { cursor: command(BIN, ['--version'], cwd, env) };
}

// Same shape as the Claude prompt: shared instructions, role, project files, memory. Subagent
// delegation notes are omitted because the CLI runs a single agent.
export function systemPrompt({ shared, role, instructions, memory }) {
  return claudeSystemPrompt({ shared: { ...shared, agent: Object.fromEntries(Object.entries(shared.agent).filter(([, agent]) => agent.mode !== 'subagent').concat([[role, shared.agent[role]]])) }, role, instructions, memory });
}

export function invocation({ prompt, model, systemPromptText = '', denied = [] }) {
  const args = ['--force', '--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  const rules = denied.length ? `\n\nForbidden shell commands (never run them, the runner owns delivery): ${denied.join('; ')}.` : '';
  const input = `${systemPromptText ? `${systemPromptText}\n\n---\n\n` : ''}${prompt}${rules}\n`;
  return { bin: BIN, args, input };
}

const LIMIT = /rate.?limit|usage limit|too many requests|\b429\b|quota/i;

export function stopReason({ stderrFile }) {
  try {
    const text = fs.readFileSync(stderrFile, 'utf8').slice(-65536);
    return LIMIT.test(text) ? 'rate-limited' : null;
  } catch { return null; }
}

// Cursor stream-json shares the assistant/result shapes with Claude Code; its tool events are
// `tool_call` records whose single key names the tool (readToolCall, shellToolCall, ...).
export function parseEvent(event, context) {
  const { push } = context;
  if (event.type === 'tool_call' && event.tool_call && typeof event.tool_call === 'object') {
    if (event.subtype && event.subtype !== 'started') return true;
    const [name, call] = Object.entries(event.tool_call)[0] ?? ['tool', {}];
    const args = call?.args ?? {};
    const detail = args.command ?? args.path ?? args.pattern ?? args.query ?? Object.values(args).find(value => typeof value === 'string') ?? '';
    push('coordinator', 'tool', `${name.replace(/ToolCall$/, '')}${detail ? `: ${detail}` : ''}`);
    return true;
  }
  return false;
}

export function ask() {
  return Promise.reject(new Error('The cursor engine does not yet support bounded question sessions'));
}
