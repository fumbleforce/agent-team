// What the Knowledge tab reads from the API, and the few words it derives from it.
export type ScopeKey = 'subproject' | 'project' | 'team' | 'org';
export interface ScopeChoice { key: ScopeKey; label: string; note: string }
export interface PageRef { id: string; path: string; title: string }
export interface Memory { id: string; title: string; body: string; type: string; status: string; stale: boolean; hits: number; lastHitAt: number | null; createdAt: number; source?: string; score?: number; roleSlug?: string | null; supersededBy?: string | null; supersedeReason?: string | null }
export interface Tree { scopes: ScopeChoice[]; scope: ScopeKey; canWrite: boolean; pages: PageRef[]; memories: Memory[] }
export interface PageView { page: { id: string; path: string; title: string; rev: number; body: string; updatedAt: number; readByToday: number }; scope: ScopeKey; canWrite: boolean }
export interface Revision { rev: number; author: string; authorKind: string; note: string | null; at: number; current: boolean; waiting: boolean }
export interface RevisionView { revision: { rev: number; body: string; note: string | null; at: number }; diff: { from: number; to: number; text: string; added: number; removed: number } }
export interface Decision { id: string; kind: string; outcome: string; summary: string; waitingForPerson: boolean; at: number; issueNumber: number | null; projectSlug?: string }
export type HitTarget = { kind: 'page'; pageId: string } | { kind: 'memory'; memoryId: string; scope: ScopeKey | null } | { kind: 'issue'; slug: string; number: number } | { kind: 'discussion'; slug: string };
export interface Hit { type: string; id: string; title: string; excerpt: string; target: HitTarget }

const many = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// "3 days ago", "today": how long since something happened, to the day once it is more than a day.
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 1440) return `${many(Math.round(minutes / 60), 'hour')} ago`;
  const days = Math.round(minutes / 1440);
  return days < 60 ? `${many(days, 'day')} ago` : `${many(Math.round(days / 30), 'month')} ago`;
}

// How much a memory has been used, as a sentence: agents use one when it is handed to them at the start of a turn or comes up in their search.
export function usage(memory: Pick<Memory, 'hits' | 'lastHitAt' | 'createdAt'>, now = Date.now()): string {
  if (memory.hits === 0 || memory.lastHitAt === null) return `never used, noted ${ago(memory.createdAt, now)}`;
  return `used ${memory.hits === 1 ? 'once' : `${memory.hits} times`}, last ${ago(memory.lastHitAt, now)}`;
}

// Folder and file names are made from what people type: lower case, words joined by dashes.
export const slugify = (text: string) => text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
// And read back the other way for display: "release-notes" is shown as "Release notes".
export const folderName = (dir: string) => dir.split('/').map(part => { const words = part.replace(/[-_.]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); }).join(' › ');
export const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');
export const foldersOf = (pages: PageRef[]) => [...new Set(pages.map(page => folderOf(page.path)).filter(Boolean))].sort();
export const pathFor = (folder: string, title: string) => `${folder ? `${folder}/` : ''}${slugify(title) || 'page'}.md`;
