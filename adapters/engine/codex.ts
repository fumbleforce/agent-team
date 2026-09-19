import type { TraceStepInput } from '@agent-team/protocol';
import { allowlistedEnvironment, type EngineAdapter } from './contract.ts';

const LIMIT = /rate.?limit|usage limit|too many requests|\b429\b|insufficient_quota/i;
type Item = { type?: string; text?: string; command?: string; changes?: { path?: string }[] };
type StreamEvent = { type?: string; thread_id?: string; item?: Item; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string }; message?: string };

// No per-tool policy: restrictions are the engine's sandbox mode. The platform server is reached through the CLI shim the worker puts on PATH.
export const codex: EngineAdapter = {
  name: 'codex',
  bin: 'codex',
  capabilities: { resume: 'id', mcp: 'none', toolPolicy: 'sandbox', bounded: true, structuredOutput: true, usageLimits: 'detect', cost: 'tokens' },
  environment: env => allowlistedEnvironment(env),

  prepare(spec, _turnDir, env) {
    const sandbox = spec.toolProfile === 'write' ? 'workspace-write' : 'read-only';
    const head = spec.sessionId ? ['exec', 'resume', spec.sessionId] : ['exec'];
    return {
      bin: 'codex',
      args: [...head, '--json', '--sandbox', sandbox, '--cd', spec.cwd, '--skip-git-repo-check', ...(spec.model ? ['--model', spec.model] : []), '-'],
      // The whole prompt, system part first, goes on stdin.
      input: `${spec.systemPrompt}\n\n---\n\n${spec.prompt}`,
      env,
      files: [],
    };
  },

  parse(line, state) {
    let event: StreamEvent;
    try { event = JSON.parse(line); } catch { return []; }
    if (event.type === 'thread.started' && event.thread_id) state.sessionId = event.thread_id;
    if ((event.type === 'error' || event.type === 'turn.failed') && LIMIT.test(event.error?.message ?? event.message ?? '')) state.limited = true;
    if (event.type === 'turn.completed') { state.tokensIn += event.usage?.input_tokens ?? 0; state.tokensOut += event.usage?.output_tokens ?? 0; return []; }
    if (event.type !== 'item.completed' || !event.item) return [];
    const item = event.item;
    const step = (kind: TraceStepInput['kind'], title: string): TraceStepInput[] => [{ seq: state.nextSeq++, kind, title: title.replace(/\s+/g, ' ').slice(0, 300), status: 'ok' }];
    if ((item.type === 'agent_message' || item.type === 'reasoning') && item.text?.trim()) { if (item.type === 'agent_message') state.summary = item.text.slice(0, 2000); return step('think', item.text); }
    if (item.type === 'command_execution' && item.command) return step('run', `shell: ${item.command}`);
    if (item.type === 'file_change') return step('edit', `edit: ${(item.changes ?? []).map(change => change.path).filter(Boolean).join(', ')}`);
    return [];
  },

  classifyExit(exit, state, stderrTail) {
    if (state.limited || LIMIT.test(stderrTail)) return 'rate-limited';
    if (/no (rollout|session|conversation) found/i.test(stderrTail)) return 'resume-missing';
    return exit.code === 0 ? 'completed' : 'crashed';
  },
};
