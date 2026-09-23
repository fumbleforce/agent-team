import { stripVTControlCharacters } from 'node:util';
import { allowlistedEnvironment, type EngineAdapter } from './contract.ts';

const LIMIT = /rate.?limit|usage limit|too many requests|\b429\b|quota/i;
type StreamEvent = { type?: string; session_id?: string; tool_call?: Record<string, { args?: Record<string, unknown> }>; message?: { content?: { type?: string; text?: string }[] }; result?: string };
const KIND = { read: 'read', grep: 'read', glob: 'read', ls: 'read', edit: 'edit', write: 'edit', delete: 'edit', shell: 'run' } as const;

// Restrictions are the engine's own permission config on the worker; bounded turns are refused on workers that are not isolated.
export const cursor: EngineAdapter = {
  name: 'cursor',
  bin: 'agent',
  capabilities: { resume: 'id', mcp: 'none', toolPolicy: 'prompt', bounded: false, structuredOutput: false, usageLimits: 'detect', cost: 'none' },
  environment: env => allowlistedEnvironment(env),
  // The tool lists the models this account may use, one "id - Name" a line; "(current)" and "(default)" marks are dropped.
  async discover({ run }) {
    const lines = stripVTControlCharacters(await run(['models'])).split(/\r?\n/);
    const models = lines.flatMap(line => { const found = /^\s*([a-z0-9][\w.:-]{0,119})\s+-\s+(.+?)\s*(?:\((?:current|default)\)\s*)*$/i.exec(line); return found ? [{ id: found[1]!, name: found[2]!.slice(0, 120) }] : []; });
    return { models, efforts: [] };
  },

  prepare(spec, _turnDir, env) {
    return {
      bin: 'agent',
      args: ['--print', '--output-format', 'stream-json', ...(spec.toolProfile === 'write' ? ['--force'] : []), ...(spec.sessionId ? ['--resume', spec.sessionId] : []), ...(spec.model ? ['--model', spec.model] : [])],
      input: `${spec.systemPrompt}\n\n---\n\n${spec.prompt}`,
      env,
      files: [],
    };
  },

  parse(line, state) {
    let event: StreamEvent;
    try { event = JSON.parse(line); } catch { return []; }
    if (event.session_id) state.sessionId = event.session_id;
    if (event.type === 'result' && typeof event.result === 'string') { state.summary = event.result.slice(0, 2000); return []; }
    if (event.type === 'assistant') return (event.message?.content ?? []).filter(block => block.type === 'text' && block.text?.trim()).map(block => ({ seq: state.nextSeq++, kind: 'think' as const, title: block.text!.replace(/\s+/g, ' ').slice(0, 300), status: 'ok' as const }));
    if (event.type !== 'tool_call' || !event.tool_call) return [];
    const [name, call] = Object.entries(event.tool_call)[0] ?? [];
    if (!name) return [];
    const tool = name.replace(/ToolCall$/, '').toLowerCase();
    const detail = String(call?.args?.path ?? call?.args?.command ?? call?.args?.pattern ?? '').slice(0, 120);
    return [{ seq: state.nextSeq++, kind: KIND[tool as keyof typeof KIND] ?? 'run', title: detail ? `${tool}: ${detail}` : tool, status: 'ok' }];
  },

  classifyExit(exit, state, stderrTail) {
    if (state.limited || LIMIT.test(stderrTail)) return 'rate-limited';
    return exit.code === 0 ? 'completed' : 'crashed';
  },
};
