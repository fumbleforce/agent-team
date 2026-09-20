import { useState, type ClipboardEvent, type FormEvent } from 'react';
import { api, postToThread, uploadImage, type Agent, type Me, type ThreadMessagesView } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Attachment, Composer, ListLink, mentionOptions, Message, resolveAuthor, SidePanel, StatusLine, SubHeader } from '../../patterns';
import { Button, Chip, Field, Input, LinkButton, MarkerCanvas, SectionLabel, Select, Spinner, Text, Textarea, type Marker } from '../../ui';

interface Issue { id: string; number: number; title: string; state: string; source: string; thread_id: string; attachment_id: string | null; task: { key: string; state: string; assigneeAgentId: string | null } | null; pending: { agentId: string; running: boolean } | null }
const TASK_STATE: Record<string, string> = { backlog: 'waiting', assigned: 'assigned', in_progress: 'in progress', awaiting_decision: 'waiting for a decision', in_review: 'in review', approved: 'approved', merging: 'merging', done: 'done', blocked: 'blocked', stopped: 'stopped', canceled: 'canceled', quarantined: 'needs you' };

async function upload(file: File): Promise<string> {
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? 'Upload failed');
  return (await response.json() as { id: string }).id;
}

function RaiseIssue({ slug, onRaised }: { slug: string; onRaised(number: number): void }) {
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paste = (event: ClipboardEvent) => { const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) void upload(file).then(setAttachmentId, failure => setError((failure as Error).message)); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { onRaised((await api<{ number: number }>(`/api/projects/${slug}/issues`, { title: form.get('title'), body: form.get('body'), attachmentId })).number); } catch (failure) { setError((failure as Error).message); }
  };
  return (
    <form onSubmit={submit} onPaste={paste} className="flex max-w-160 flex-col gap-3.5">
      <Text as="h2" size="heading">Raise an issue</Text>
      <Field label="Title"><Input name="title" required maxLength={200} /></Field>
      <Field label="What is wrong, and where"><Textarea name="body" rows={5} required /></Field>
      {attachmentId ? <Attachment id={attachmentId} onRemove={() => setAttachmentId(null)} /> : <Text size="caption" tone="faint">Paste a screenshot anywhere in this form to attach it.</Text>}
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div><Button variant="primary" type="submit">Send to team</Button></div>
    </form>
  );
}

export function IssuesTab({ slug, number, roster, me, navigate }: { slug: string; number: number | null; roster: Agent[]; me: Me; navigate(to: string): void }) {
  const list = useResource<{ issues: Issue[] }>(`/api/projects/${slug}/issues`);
  const selected = list.data?.issues.find(issue => issue.number === number) ?? null;
  const thread = useResource<ThreadMessagesView>(selected ? `/api/threads/${selected.thread_id}/messages` : null);
  useStream(event => event.type.startsWith('issue.') || event.type.startsWith('turn.') || event.type.startsWith('task.') || event.type === 'decision.recorded', list.reload);
  const nameOf = (agentId: string | null) => roster.find(agent => agent.id === agentId)?.name ?? 'Someone';
  useStream(event => event.type === 'message.posted' && event.threadId === selected?.thread_id, thread.reload);

  return (
    <div className="flex min-h-0 grow">
      <SidePanel label="Issues" wide>
        <div className="flex items-center px-1.5 pb-1.5"><SectionLabel aside={<Button size="sm" onClick={() => navigate(`/p/${slug}/issues`)}>+ Raise</Button>}>Issues</SectionLabel></div>
        {list.data?.issues.map(issue => <ListLink key={issue.id} href={`/p/${slug}/issues/${issue.number}`} active={issue.number === number} mark={`#${issue.number}`} aside={issue.state === 'closed' ? <Chip>closed</Chip> : issue.task ? <Chip tone="working">{issue.task.key}</Chip> : issue.pending ? <Spinner /> : undefined}>{issue.title}</ListLink>)}
      </SidePanel>
      {selected ? (
        <div className="flex min-w-0 grow flex-col">
          <SubHeader>
            <Text size="small" tone="muted" mono>#{selected.number}</Text><Text size="title" truncate>{selected.title}</Text>
            <span className="ml-auto flex items-center gap-1.5">
              {selected.task
                ? <LinkButton size="sm" href={`/p/${slug}/tasks`}>{selected.task.key} · {nameOf(selected.task.assigneeAgentId)} · {TASK_STATE[selected.task.state] ?? selected.task.state}</LinkButton>
                : selected.state === 'open' && <Select compact aria-label="Make it a task for" value="" onChange={event => { if (event.target.value) void api(`/api/projects/${slug}/issues/${selected.number}/accept`, { agentId: event.target.value }).then(list.reload); }}><option value="">Make it a task for…</option>{roster.filter(agent => agent.status !== 'paused').map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.title}</option>)}</Select>}
              {selected.state === 'open' && <Button onClick={() => { void api(`/api/projects/${slug}/issues/${selected.number}/close`, {}).then(list.reload); }}>Close</Button>}</span>
          </SubHeader>
          <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-6 py-4.5">
            {thread.data?.messages.map(message => (
              <div key={message.id} className="flex flex-col gap-2">
                <Message message={message} author={resolveAuthor(message, roster, me.user)} />
                {typeof message.payload.attachmentId === 'string' && Array.isArray(message.payload.markers) && <MarkerCanvas src={`/api/attachments/${message.payload.attachmentId}`} markers={message.payload.markers as Marker[]} />}
              </div>
            ))}
          </div>
          {selected.pending && <div className="px-6 pb-2"><StatusLine tone="working" busy>{nameOf(selected.pending.agentId)} {selected.pending.running ? 'is answering' : 'is up next on this'}</StatusLine></div>}
          <Composer placeholder="Reply — the team sees this in the issue's thread" action="Reply" mentions={mentionOptions(roster)} onAttach={uploadImage} onSend={(body, images) => postToThread(selected.thread_id, body, images)} />
        </div>
      ) : <div className="min-w-0 grow overflow-y-auto px-6 py-5"><RaiseIssue slug={slug} onRaised={raised => { list.reload(); navigate(`/p/${slug}/issues/${raised}`); }} /></div>}
    </div>
  );
}
