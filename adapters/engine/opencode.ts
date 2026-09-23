import path from 'node:path';
import type { TraceStepInput } from '@agent-team/protocol';
import { allowlistedEnvironment, mcpServers, type EngineAdapter } from './contract.ts';

const LIMIT = /rate.?limit|too many requests|\b429\b|\b402\b|insufficient|quota/i;
const KIND: Record<string, TraceStepInput['kind']> = { read: 'read', grep: 'read', glob: 'read', list: 'read', webfetch: 'read', edit: 'edit', write: 'edit', patch: 'edit', bash: 'run' };
type Part = { type?: string; text?: string; tool?: string; state?: { input?: Record<string, unknown> }; tokens?: { input?: number; output?: number }; cost?: number };
type StreamEvent = { type?: string; sessionID?: string; part?: Part; error?: { message?: string } };

// Serves hosted routers and local models alike: the provider is part of the model string and of the engine's own config.
export const opencode: EngineAdapter = {
  name: 'opencode',
  bin: 'opencode',
  capabilities: { resume: 'id', mcp: 'http', toolPolicy: 'config', bounded: true, structuredOutput: false, usageLimits: 'detect', cost: 'tokens' },
  environment: env => allowlistedEnvironment(env, ['OPENROUTER_API_KEY', 'OLLAMA_HOST']),
  // The tool lists every model of the providers set up in it, one "provider/model" a line.
  async discover({ run }) {
    const models = [...new Set((await run(['models'])).split(/\r?\n/).map(line => line.trim()).filter(line => /^[\w.-]+\/\S{1,100}$/.test(line)))];
    return { models: models.map(id => ({ id, name: id })), efforts: [] };
  },

  prepare(spec, turnDir, env) {
    const readOnly = spec.toolProfile !== 'write';
    // Tool policy and the platform server travel in a private per-turn config file; the token is never in argv or the environment.
    const config = {
      agent: { turn: { mode: 'primary', prompt: spec.systemPrompt, permission: { edit: readOnly ? 'deny' : 'allow', bash: spec.toolProfile === 'none' || (readOnly && spec.toolProfile !== 'verify') ? 'deny' : { '*': 'allow', '*git push*': 'deny', '*git reset --hard*': 'deny' }, task: 'deny' } } },
      // The platform and every connected tool, tokens read from the turn's private files.
      mcp: Object.fromEntries(Object.entries(mcpServers(spec)).map(([name, server]) => [name, { type: 'remote', url: server.url, enabled: true, ...(server.headers ? { headers: server.headers } : {}) }])),
    };
    return {
      bin: 'opencode',
      args: ['run', '--agent', 'turn', '--format', 'json', '--dir', spec.cwd, ...(spec.sessionId ? ['--session', spec.sessionId] : []), ...(spec.model ? ['--model', spec.model] : [])],
      input: spec.prompt,
      env: { ...env, OPENCODE_CONFIG: path.join(turnDir, 'opencode.json') },
      files: [{ path: path.join(turnDir, 'opencode.json'), content: JSON.stringify(config) }],
    };
  },

  parse(line, state) {
    let event: StreamEvent;
    try { event = JSON.parse(line); } catch { return []; }
    if (event.sessionID) state.sessionId = event.sessionID;
    if (event.type === 'error' && LIMIT.test(event.error?.message ?? '')) state.limited = true;
    const part = event.part;
    if (!part) return [];
    if (part.type === 'step-finish' || event.type === 'step_finish') { state.tokensIn += part.tokens?.input ?? 0; state.tokensOut += part.tokens?.output ?? 0; state.costUsd += part.cost ?? 0; return []; }
    if (part.type === 'text' && part.text?.trim()) { state.summary = part.text.slice(0, 2000); return [{ seq: state.nextSeq++, kind: 'think', title: part.text.replace(/\s+/g, ' ').slice(0, 300), status: 'ok' }]; }
    if ((part.type === 'tool' || event.type === 'tool_use') && part.tool && !part.tool.startsWith('platform_')) {
      const input = part.state?.input ?? {};
      const detail = String(input.description ?? input.command ?? input.filePath ?? input.pattern ?? '').replace(/\s+/g, ' ').slice(0, 120);
      return [{ seq: state.nextSeq++, kind: KIND[part.tool] ?? 'run', title: detail ? `${part.tool}: ${detail}` : part.tool, status: 'ok' }];
    }
    return [];
  },

  classifyExit(exit, state, stderrTail) {
    if (state.limited || LIMIT.test(stderrTail)) return 'rate-limited';
    if (/session.*not found/i.test(stderrTail)) return 'resume-missing';
    return exit.code === 0 ? 'completed' : 'crashed';
  },
};
