import type { NotifierEntry } from './contract.ts';
import { ntfy } from './ntfy.ts';

export type { Notice, Notifier, NotifierEntry, NotifierField } from './contract.ts';
export const NOTIFIERS: NotifierEntry[] = [ntfy];
export const notifierEntry = (kind: string): NotifierEntry | null => NOTIFIERS.find(entry => entry.kind === kind) ?? null;
