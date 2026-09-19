import { fileURLToPath } from 'node:url';
import { allowlistedEnvironment, type EngineAdapter } from './contract.ts';

// The script beside this file, with this file's extension: `.ts` in a checkout, the built `.js` in the published package.
const SCRIPT = fileURLToPath(import.meta.url).replace(/fake(\.[jt]s)$/, 'fake-engine$1');

// A scripted engine for tests and the demo: no model, no network. FAKE_SCENARIO selects the behaviour.
export const fake: EngineAdapter = {
  name: 'fake',
  bin: process.execPath,
  capabilities: { resume: 'id', mcp: 'none', toolPolicy: 'prompt', bounded: true, structuredOutput: false, usageLimits: 'detect', cost: 'usd' },
  environment: env => allowlistedEnvironment(env, ['FAKE_SCENARIO']),
  prepare: (spec, turnDir, env) => ({ bin: process.execPath, args: [SCRIPT, spec.kind, '--turn-dir', turnDir, ...(spec.sessionId ? ['--resume', spec.sessionId] : ['--session', `fake-${spec.turnId}`])], input: spec.prompt, env, files: [] }),
  parse(line, state) {
    let event: { type?: string; kind?: string; title?: string; detail?: string; target?: string; body?: string; session?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; summary?: string };
    try { event = JSON.parse(line); } catch { return []; }
    if (event.type === 'session' && event.session) state.sessionId = event.session;
    if (event.type === 'limit') state.limited = true;
    if (event.type === 'result') { state.tokensIn += event.tokensIn ?? 0; state.tokensOut += event.tokensOut ?? 0; state.costUsd += event.costUsd ?? 0; state.summary = event.summary ?? null; }
    if (event.type !== 'step' || !event.title) return [];
    const kind = (['read', 'edit', 'run', 'think', 'message'] as const).find(item => item === event.kind) ?? 'think';
    return [{ seq: state.nextSeq++, kind, title: event.title, ...(event.detail ? { detail: event.detail } : {}), ...(event.target ? { target: event.target } : {}), ...(event.body ? { body: event.body } : {}), status: 'ok' }];
  },
  classifyExit: (exit, state, stderrTail) => (state.limited ? 'rate-limited' : /session not found/i.test(stderrTail) ? 'resume-missing' : exit.code === 0 ? 'completed' : 'crashed'),
};
