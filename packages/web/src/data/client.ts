import type { AgentView, BoardView, MessageView, TaskCardView } from '@agent-team/protocol';

export class ApiError extends Error {
  status: number; code: string; fields: Record<string, string>;
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

// `headers` carries the API conventions a call opts into: `If-Match` with the version last read, `Idempotency-Key` on a create.
export async function api<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'error', json?.error?.message ?? response.statusText, json?.error?.fields ?? {});
  return json as T;
}

// Stores a pasted or picked image and returns what a composer shows for it.
export async function uploadImage(file: File): Promise<{ id: string; name: string }> {
  const name = file.name || 'pasted-image.png';
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json?.error?.code ?? 'error', json?.error?.message ?? 'Upload failed');
  return { id: (json as { id: string }).id, name };
}

// Posts to a thread. Attached images are stored on the message and shown under it.
export const postToThread = (threadId: string, body: string, attachmentIds: string[] = []): Promise<void> =>
  api(`/api/threads/${threadId}/messages`, { body, attachmentIds }).then(() => undefined);

export interface Me { user: { id: string; email: string; name: string; orgRole: string }; org: { name: string; accent: string; currency: string } | null; seq: number }
export interface ProjectNode { id: string; slug: string; name: string; kind: string; status: string; team: { id: string; name: string; seats: number } | null; progress: number; subprojects: { id: string; slug: string; name: string; progress: number }[] }
// The shapes of the most used resources come from the schemas the coordinator answers with; nothing here restates them.
export type Agent = AgentView;
export type TaskCardData = TaskCardView;
export type Board = BoardView;
export type { CostCurrency, CostsSummaryView, CostTotal, HarnessHealthView, ProjectView, RoleChoiceView, SeatView, TeamView, ThreadMessagesView } from '@agent-team/protocol';
export type Message = MessageView;
export interface StreamEvent { seq: number; type: string; projectId: string | null; threadId: string | null; taskId: string | null; payload: Record<string, unknown> }
