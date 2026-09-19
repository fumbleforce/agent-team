import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { TraceStepInput } from '@agent-team/protocol';
import { allowlistedEnvironment, type EngineAdapter, type ParseState } from './contract.ts';

const LIMIT = /rate.?limit|usage limit|limit reached|hit your limit|out of (?:extra )?usage|too many requests|\b429\b/i;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const KIND: Record<string, TraceStepInput['kind']> = { Read: 'read', Grep: 'read', Glob: 'read', LS: 'read', WebFetch: 'read', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'run' };
// Force-push and history rewrites stay denied whatever a role allows; publishing is worker code.
const DENIED = ['Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(gh pr merge:*)', 'Bash(glab mr merge:*)', 'Agent'];

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
type StreamEvent = { type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; message?: { content?: Block[] }; rate_limit_info?: { status?: string } };

const detail = (input: Record<string, unknown> = {}) => String(input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.query ?? '').replace(/\s+/g, ' ').slice(0, 120);

export const claude: EngineAdapter = {
  name: 'claude',
  bin: 'claude',
  capabilities: { resume: 'id', mcp: 'http', toolPolicy: 'enforced', bounded: true, structuredOutput: true, usageLimits: 'windows', cost: 'usd' },

  // Subscription billing: no key, token, base URL or cloud switch may select metered billing behind the owner's back.
  environment: env => allowlistedEnvironment(env),

  prepare(spec, turnDir, env) {
    const systemFile = path.join(turnDir, 'system-prompt.md');
    const mcpFile = path.join(turnDir, 'mcp.json');
    // The token lives only in this private per-turn file, never in argv or the environment.
    const servers = spec.platform ? { platform: { type: 'http', url: spec.platform.url, headers: { Authorization: `Bearer ${readFileSync(spec.platform.tokenFile, 'utf8').trim()}` } } } : {};
    const tools = spec.toolProfile === 'write' ? [] : ['--tools', spec.toolProfile === 'none' ? '' : READ_TOOLS.join(',')];
    return {
      bin: 'claude',
      args: [
        '--print', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', mcpFile,
        '--permission-mode', spec.toolProfile === 'write' ? 'acceptEdits' : 'default', '--append-system-prompt-file', systemFile,
        ...tools, '--allowedTools', ...(spec.toolProfile === 'write' ? ['Bash'] : []), ...(spec.platform ? ['mcp__platform'] : []), '--disallowedTools', ...DENIED,
        ...(spec.sessionId ? ['--resume', spec.sessionId] : ['--session-id', spec.turnId]),
        ...(spec.model ? ['--model', spec.model] : []),
      ],
      // The prompt goes on stdin: command lines are short on Windows and visible to other processes everywhere.
      input: spec.prompt,
      env: { ...env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
      files: [{ path: systemFile, content: spec.systemPrompt }, { path: mcpFile, content: JSON.stringify({ mcpServers: servers }) }],
    };
  },

  parse(line: string, state: ParseState) {
    let event: StreamEvent;
    try { event = JSON.parse(line); } catch { return []; }
    if (event.session_id) state.sessionId = event.session_id;
    if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') state.limited = true;
    if (event.type === 'result') {
      state.costUsd += event.total_cost_usd ?? 0;
      state.tokensIn += event.usage?.input_tokens ?? 0;
      state.tokensOut += event.usage?.output_tokens ?? 0;
      state.summary = typeof event.result === 'string' ? event.result.slice(0, 2000) : state.summary;
      if (event.is_error && LIMIT.test(event.result ?? '')) state.limited = true;
      return [];
    }
    if (event.type !== 'assistant') return [];
    const steps: TraceStepInput[] = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) steps.push({ seq: state.nextSeq++, kind: 'think', title: block.text.replace(/\s+/g, ' ').slice(0, 300), status: 'ok' });
      // Platform calls are traced by the coordinator when it handles them, identically for every engine.
      if (block.type === 'tool_use' && block.name && !block.name.startsWith('mcp__platform')) {
        const info = detail(block.input);
        steps.push({ seq: state.nextSeq++, kind: KIND[block.name] ?? 'run', title: info ? `${block.name}: ${info}` : block.name, status: 'ok' });
      }
    }
    return steps;
  },

  classifyExit(exit, state, stderrTail) {
    if (state.limited || LIMIT.test(stderrTail)) return 'rate-limited';
    if (/No conversation found|session.*not found/i.test(stderrTail)) return 'resume-missing';
    if (/not logged in|authentication|unauthorized/i.test(stderrTail)) return 'auth';
    if (/context.*(length|window|overflow)|prompt is too long/i.test(stderrTail)) return 'context-overflow';
    return exit.code === 0 ? 'completed' : 'crashed';
  },
};
