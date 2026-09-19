import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageAdapter } from '@agent-team/storage';
import { createEventLog, type EventLog } from './events/log.ts';

export interface Context {
  storage: StorageAdapter;
  events: EventLog;
  now: () => number;
  machineToken: string;
  webRoot: string | null;
  // Where files the coordinator owns live: attachments today.
  dataDir: string;
  secureCookies: boolean;
  // Set only by the demo command: the account that /demo/enter signs in.
  demoLogin: { email: string; password: string } | null;
}

export function createContext(options: { storage: StorageAdapter; machineToken: string; webRoot?: string | null; dataDir?: string; secureCookies?: boolean; now?: () => number; demoLogin?: Context['demoLogin'] }): Context {
  const now = options.now ?? Date.now;
  return { storage: options.storage, events: createEventLog(options.storage, now), now, machineToken: options.machineToken, webRoot: options.webRoot ?? null, dataDir: options.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'agent-team-data-')), secureCookies: options.secureCookies ?? false, demoLogin: options.demoLogin ?? null };
}

export class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = () => new HttpError(403, 'forbidden', 'Not allowed');
