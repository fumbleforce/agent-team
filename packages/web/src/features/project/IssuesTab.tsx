import { useEffect, useState, type ClipboardEvent, type FormEvent } from 'react';
import { api } from '../../data/client';
import { useResource } from '../../data/useResource';
import { Attachment } from '../../patterns';
import { Button, Field, Input, Text, Textarea } from '../../ui';

async function upload(file: File): Promise<string> {
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? 'Upload failed');
  return (await response.json() as { id: string }).id;
}

// What is raised lands in the board's inbox as a task; the PM takes it from there.
export function RaiseIssue({ slug, onRaised }: { slug: string; onRaised(taskId: string): void }) {
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paste = (event: ClipboardEvent) => { const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) void upload(file).then(setAttachmentId, failure => setError((failure as Error).message)); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { onRaised((await api<{ taskId: string }>(`/api/projects/${slug}/issues`, { title: form.get('title'), body: form.get('body'), attachmentId })).taskId); } catch (failure) { setError((failure as Error).message); }
  };
  return (
    <form onSubmit={submit} onPaste={paste} className="flex flex-col gap-3.5">
      <Field label="Title"><Input name="title" required maxLength={200} /></Field>
      <Field label="What is wrong, and where"><Textarea name="body" rows={5} required /></Field>
      {attachmentId ? <Attachment id={attachmentId} onRemove={() => setAttachmentId(null)} /> : <Text size="caption" tone="faint">Paste a screenshot anywhere in this form to attach it.</Text>}
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div><Button variant="primary" type="submit">Send to team</Button></div>
    </form>
  );
}

// Links to an issue from before issues and tasks were one thing lead to the task it is.
export function IssueRedirect({ slug, number, navigate }: { slug: string; number: number | null; navigate(to: string): void }) {
  const list = useResource<{ issues: { number: number; task: { id: string } | null }[] }>(`/api/projects/${slug}/issues`);
  useEffect(() => { if (!list.data) return; const task = list.data.issues.find(issue => issue.number === number)?.task; navigate(task ? `/p/${slug}/tasks/${task.id}` : `/p/${slug}/tasks`); }, [list.data]);
  return null;
}
