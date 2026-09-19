import type { TraceStepInput, TurnKind } from '@agent-team/protocol';

export interface EngineCapabilities {
  resume: 'id' | 'none';
  mcp: 'http' | 'stdio' | 'none';
  toolPolicy: 'enforced' | 'config' | 'sandbox' | 'prompt';
  bounded: boolean;
  structuredOutput: boolean;
  usageLimits: 'windows' | 'detect' | 'none';
  cost: 'usd' | 'tokens' | 'none';
}

export interface TurnSpec {
  turnId: string;
  kind: TurnKind;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  model: string | null;
  sessionId: string | null;
  toolProfile: 'write' | 'read-only' | 'none';
  platform: { url: string; tokenFile: string } | null;
}

export interface PreparedTurn { bin: string; args: string[]; input?: string; env: NodeJS.ProcessEnv; files: { path: string; content: string }[] }
export type StopReason = 'completed' | 'rate-limited' | 'auth' | 'context-overflow' | 'resume-missing' | 'crashed';

export interface ParseState { nextSeq: number; sessionId: string | null; tokensIn: number; tokensOut: number; costUsd: number; summary: string | null; limited: boolean }
export const newParseState = (): ParseState => ({ nextSeq: 0, sessionId: null, tokensIn: 0, tokensOut: 0, costUsd: 0, summary: null, limited: false });

// One engine CLI behind one contract. Secrets never appear in argv; `parse` is pure apart from `state`.
export interface EngineAdapter {
  name: string;
  bin: string;
  capabilities: EngineCapabilities;
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  prepare(spec: TurnSpec, turnDir: string, env: NodeJS.ProcessEnv): PreparedTurn;
  parse(line: string, state: ParseState): TraceStepInput[];
  classifyExit(exit: { code: number | null; signal: string | null }, state: ParseState, stderrTail: string): StopReason;
}

// Everything a model process may inherit; anything else, including unknown secrets, is dropped.
const ALLOWED = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_[A-Z]+|TERM|SHELL|COMSPEC|PATHEXT|SYSTEMROOT|SystemRoot|WINDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/;
export function allowlistedEnvironment(env: NodeJS.ProcessEnv, extra: readonly string[] = []): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => ALLOWED.test(key) || extra.includes(key)));
}
