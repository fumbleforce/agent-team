import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageAdapter } from '@agent-team/storage';
import { createEventLog, type EventLog } from './events/log.ts';
import { createArtifacts, type ArtifactOptions } from '../../../adapters/artifacts/index.ts';
import type { ArtifactStore } from '../../../adapters/artifacts/contract.ts';
import { createSecretStore, type SecretStore } from './auth/secretStore.ts';
import { environmentDecider } from '../../../adapters/decider/index.ts';
import type { ScmApi } from './sync/scm.ts';
import type { Decider } from '../../../adapters/decider/contract.ts';

// Where bodies too large for a database row are kept. `dir` is the local folder; every other option belongs to the named kind.
export type ArtifactsConfig = { kind?: string; dir?: string } & Omit<ArtifactOptions, 'root' | 'run' | 'env'>;

export interface Context {
  storage: StorageAdapter;
  events: EventLog;
  now: () => number;
  machineToken: string;
  // Where credentials are looked up: this machine's variables, with the keys entered in the app placed over them.
  env: NodeJS.ProcessEnv;
  secrets: SecretStore;
  // How the coordinator reaches other services; replaced in tests.
  fetch: typeof fetch;
  // The model that answers typed questions (what kind of report, how hard a task). By default it reads its key from `env` on each call, so a key entered in the app counts; null decides nothing this way.
  decider: Decider | null;
  webRoot: string | null;
  // Where files the coordinator owns live: attachments today.
  dataDir: string;
  // Large step artifacts: run output past the inline limit, raw engine streams, screenshots.
  artifacts: ArtifactStore;
  // How long trace steps and their artifacts outlive a terminal task, in days.
  traceRetentionDays: number;
  secureCookies: boolean;
  // The request header a loopback identity proxy sets to the signed-in email; null keeps the mode off.
  trustedHeader: string | null;
  // True when the coordinator listens on this machine only; some conveniences (starting a worker from the app) exist only then.
  local: boolean;
  // The code host's API for a kind, where its token is present; null where outside polling is off.
  scm: ((kind: string) => Promise<ScmApi | null>) | null;
  // Set only by `agent-team up` on a loopback bind: the one person this machine's coordinator is for, signed in without a password.
  localOwner: LocalOwner | null;
  // Set only by the demo command: the account that /demo/enter signs in.
  demoLogin: { email: string; password: string } | null;
}

export interface LocalOwner { name: string; email: string; orgName: string }

// Tests never reach a paid model: under the test runner a context that was not given a decider has none, whatever keys the shell holds.
const underTest = 'NODE_TEST_CONTEXT' in process.env;

export function createContext(options: { storage: StorageAdapter; machineToken: string; webRoot?: string | null; dataDir?: string; artifacts?: ArtifactsConfig; traceRetentionDays?: number; secureCookies?: boolean; trustedHeader?: string | null; local?: boolean; localOwner?: LocalOwner | null; now?: () => number; demoLogin?: Context['demoLogin']; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; decider?: Decider | null }): Context {
  const now = options.now ?? Date.now;
  const dataDir = options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'agent-team-data-'));
  const { kind, dir, ...rest } = options.artifacts ?? {};
  const artifacts = createArtifacts(kind, { ...rest, root: dir ?? path.join(dataDir, 'artifacts') });
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  return { storage: options.storage, env, fetch: request, decider: options.decider !== undefined ? options.decider : underTest ? null : environmentDecider(env, request), secrets: createSecretStore({ storage: options.storage, dataDir, env, now }), artifacts, traceRetentionDays: options.traceRetentionDays ?? 30, events: createEventLog(options.storage, now), now, local: options.local ?? false, machineToken: options.machineToken, webRoot: options.webRoot ?? null, dataDir, secureCookies: options.secureCookies ?? false, trustedHeader: options.trustedHeader?.toLowerCase() ?? null, localOwner: options.localOwner ?? null, scm: null, demoLogin: options.demoLogin ?? null };
}

export class HttpError extends Error {
  status: number; code: string; fields: Record<string, string> | undefined;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = () => new HttpError(403, 'forbidden', 'Not allowed');
