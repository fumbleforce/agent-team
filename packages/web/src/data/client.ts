export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'error', json?.error?.message ?? response.statusText);
  return json as T;
}

export interface Me { user: { id: string; email: string; name: string; orgRole: string }; org: { name: string; accent: string; currency: string } | null; seq: number }
export interface ProjectNode { id: string; slug: string; name: string; kind: string; status: string; team: { id: string; name: string; seats: number } | null; progress: number; subprojects: { id: string; slug: string; name: string; progress: number }[] }
export interface Agent { id: string; name: string; initials: string; tint: string; title: string; persona: string; status: string; provider_id: string | null; model: string | null; is_pm: boolean; doing: string | null }
export interface TaskCardData { id: string; key: string; title: string; tag: string | null; state: string; assignee_agent_id: string | null }
export type Board = Record<'backlog' | 'in_progress' | 'review' | 'done', TaskCardData[]>;
export interface ProjectView { project: { id: string; slug: string; name: string; kind: string; status: string; parent: { slug: string; name: string } | null }; roster: Agent[]; board: Board; discussionThreadId: string | null; seq: number }
export interface Message { id: string; seq: number; authorKind: 'user' | 'agent' | 'system'; authorId: string | null; kind: string; body: string; payload: Record<string, unknown>; createdAt: number }
export interface StreamEvent { seq: number; type: string; projectId: string | null; threadId: string | null; taskId: string | null; payload: Record<string, unknown> }
