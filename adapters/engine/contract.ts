import { readFileSync } from 'node:fs';
import type { TraceStepInput, TurnKind } from '@agent-team/protocol';

export interface DiscoveredModel { id: string; name: string; note?: string; efforts?: string[] }
export interface Discovered { models: DiscoveredModel[]; efforts: string[] }
export interface DiscoverHost { env: NodeJS.ProcessEnv; run(args: string[], input?: string): Promise<string> }

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
  // How much effort the model is asked to spend, in the tool's own words; ignored by a tool that has no such choice.
  effort?: string | null;
  sessionId: string | null;
  // 'verify' reads and runs commands but edits nothing: a reviewer in a throwaway checkout of the head under review.
  toolProfile: 'write' | 'verify' | 'read-only' | 'none';
  platform: { url: string; tokenFile: string } | null;
  // External tools the team connected (remote MCP servers over HTTP), each with its token in a private file of the turn when there is one.
  // Only an engine whose `mcp` capability is 'http' is given any.
  tools?: { name: string; url: string; tokenFile: string | null }[];
}

// The engine's MCP server map for a turn: the platform and the connected tools, each token read from its private file here, never from argv.
export function mcpServers(spec: TurnSpec): Record<string, { url: string; headers?: { Authorization: string } }> {
  const bearer = (file: string) => ({ Authorization: `Bearer ${readFileSync(file, 'utf8').trim()}` });
  const servers: Record<string, { url: string; headers?: { Authorization: string } }> = {};
  for (const tool of spec.tools ?? []) if (tool.name !== 'platform') servers[tool.name] = { url: tool.url, ...(tool.tokenFile ? { headers: bearer(tool.tokenFile) } : {}) };
  if (spec.platform) servers.platform = { url: spec.platform.url, headers: bearer(spec.platform.tokenFile) };
  return servers;
}

// What an adapter's parser yields: the step as the platform stores it, plus what stays on the worker. `target` is the path an edit
// step names, used only to ask git for that file's diff; `body` is the step's full text (think text, tool output), uploaded as its artifact.
export type EngineStep = TraceStepInput & { target?: string; body?: string };

export interface PreparedTurn { bin: string; args: string[]; input?: string; env: NodeJS.ProcessEnv; files: { path: string; content: string }[] }
export type StopReason = 'completed' | 'rate-limited' | 'auth' | 'context-overflow' | 'resume-missing' | 'crashed';

// `contextTokens` is what the latest model call carried: the size of the conversation, which is what decides when a session is too long.
// `tokensIn` adds up every call of the turn, most of it the same cached text read again, and says nothing about that.
export interface ParseState { nextSeq: number; sessionId: string | null; contextTokens: number; tokensIn: number; tokensOut: number; costUsd: number; summary: string | null; limited: boolean }
export const newParseState = (): ParseState => ({ nextSeq: 0, sessionId: null, contextTokens: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, summary: null, limited: false });

// One engine CLI behind one contract. Secrets never appear in argv; `parse` is pure apart from `state`.
export interface EngineAdapter {
  name: string;
  bin: string;
  capabilities: EngineCapabilities;
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  // What the tool itself says it offers on this machine: its models (each with the effort levels it takes, when the tool says so per model)
  // and the effort levels it takes at all. Nothing of this is written down here: it is read from the tool's own files and help text on the
  // worker, once at its start, and reported with its readiness. `run` starts the tool with the given arguments (and `input` on stdin),
  // and gives what it printed; a tool that is not installed or does not answer within a few seconds gives an empty string.
  discover?(host: DiscoverHost): Promise<Discovered>;
  // The model the tool uses on this machine when a turn names none, as its own settings say. Null when they say nothing.
  defaultModel?(env: NodeJS.ProcessEnv): string | null;
  prepare(spec: TurnSpec, turnDir: string, env: NodeJS.ProcessEnv): PreparedTurn;
  parse(line: string, state: ParseState): EngineStep[];
  classifyExit(exit: { code: number | null; signal: string | null }, state: ParseState, stderrTail: string): StopReason;
}

// Everything a model process may inherit; anything else, including unknown secrets, is dropped. This is an allowlist:
// a name that is not matched here or named by the adapter does not reach the engine, so no GIT_*, SSH_* or *_ASKPASS variable does.
const ALLOWED = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_[A-Z]+|TERM|SHELL|COMSPEC|PATHEXT|SYSTEMROOT|SystemRoot|WINDIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/;
// Git inside the model process can still read the worker's own configuration through HOME. An empty `credential.helper` resets the
// helper list, so stored credentials are never handed to it, and it never prompts: publishing is worker code, agents cannot push.
const GIT_WITHOUT_CREDENTIALS = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };
export function allowlistedEnvironment(env: NodeJS.ProcessEnv, extra: readonly string[] = []): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => ALLOWED.test(key) || extra.includes(key))), ...GIT_WITHOUT_CREDENTIALS };
}

// Whether the engine itself holds a turn to its tool profile. `prompt` means only instructions do, which a strict worker does not accept.
export const enforcesToolPolicy = (capabilities: EngineCapabilities): boolean => capabilities.toolPolicy !== 'prompt';
