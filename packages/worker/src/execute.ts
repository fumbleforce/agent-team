import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { killTree, spawnCommand } from './platform.ts';
import { newParseState, type EngineAdapter, type EngineStep, type StopReason, type TurnSpec } from '../../../adapters/engine/contract.ts';

export interface TurnResult { state: 'completed' | 'failed' | 'deferred' | 'interrupted' | 'timed_out'; stopReason: StopReason | 'timeout' | 'aborted'; summary: string | null; tokensIn: number; tokensOut: number; contextTokens: number; costUsd: number; sessionId: string | null }
const GRACE_MS = 5000;

// Runs one engine process for one turn. The caller owns the lease; aborting the signal kills the process.
export function executeTurn(options: { adapter: EngineAdapter; spec: TurnSpec; turnDir: string; env: NodeJS.ProcessEnv; /* Keys the coordinator sent for this turn's provider: the only secrets that pass the adapter's allowlist by name. */ secrets?: Record<string, string>; timeoutMs: number; signal: AbortSignal; onSteps(steps: EngineStep[]): void; onSession?(sessionId: string): void; onSpawn?(pid: number | undefined): void; /* Every line the engine writes, as it came: the raw stream the worker archives. */ onLine?(line: string): void }): Promise<TurnResult> {
  const { adapter, spec, turnDir, signal } = options;
  mkdirSync(turnDir, { recursive: true, mode: 0o700 });
  const prepared = adapter.prepare(spec, turnDir, { ...adapter.environment(options.env), ...options.secrets });
  for (const file of prepared.files) writeFileSync(file.path, file.content, { mode: 0o600 });
  const state = newParseState();

  return new Promise(resolve => {
    const child = spawnCommand(prepared.bin, prepared.args, { cwd: spec.cwd, env: prepared.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // An engine that cannot be started is a failed turn with a known state, not a crashed worker.
    child.on('error', error => { clearTimeout(timer); resolve({ state: 'failed', stopReason: 'crashed', summary: `The engine could not be started: ${error.message}`.slice(0, 500), tokensIn: 0, tokensOut: 0, contextTokens: 0, costUsd: 0, sessionId: null }); });
    options.onSpawn?.(child.pid);
    child.stdin!.on('error', () => {});
    child.stdin!.end(prepared.input ?? '');
    let stderrTail = '', ended: 'timeout' | 'aborted' | null = null;
    child.stderr!.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-8192); });
    let announced = false;
    createInterface({ input: child.stdout! }).on('line', line => {
      options.onLine?.(line);
      const steps = adapter.parse(line, state);
      // The session id is passed on the moment the engine names it, before anything else can go wrong.
      if (state.sessionId && !announced) { announced = true; options.onSession?.(state.sessionId); }
      if (steps.length) options.onSteps(steps);
    });

    const stop = (reason: 'timeout' | 'aborted') => {
      if (ended) return;
      ended = reason;
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    signal.addEventListener('abort', () => stop('aborted'), { once: true });
    if (signal.aborted) stop('aborted');

    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      const usage = { summary: state.summary, tokensIn: state.tokensIn, tokensOut: state.tokensOut, contextTokens: state.contextTokens, costUsd: state.costUsd, sessionId: state.sessionId };
      if (ended) return resolve({ state: ended === 'timeout' ? 'timed_out' : 'interrupted', stopReason: ended, ...usage });
      const stopReason = adapter.classifyExit({ code, signal: exitSignal }, state, stderrTail);
      // A usage limit is nobody's fault: the turn is deferred and its item returns to the queue.
      resolve({ state: stopReason === 'completed' ? 'completed' : stopReason === 'rate-limited' ? 'deferred' : 'failed', stopReason, ...usage });
    });
  });
}

export const turnDirectory = (stateDir: string, turnId: string) => path.join(stateDir, 'turns', turnId);
