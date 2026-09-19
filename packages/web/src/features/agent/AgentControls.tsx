import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { StatusLine } from '../../patterns';
import { Button, SectionLabel, Text, Textarea } from '../../ui';

interface Direct { threadId: string; messages: { id: string; authorKind: string; body: string; createdAt: number }[] }

// Stopping is said in terms of what happens to the work: finishing the step is gentle, stopping now cuts it short and keeps everything on disk.
export function AgentControls({ id, name, status, running, onChanged }: { id: string; name: string; status: string; running: boolean; onChanged(): void }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => { setBusy(true); setError(null); try { await api(path, body); onChanged(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That did not work; try again.'); } finally { setBusy(false); } };
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Control</SectionLabel>
      <div className="flex flex-wrap gap-2">
        {status === 'paused' ? <Button variant="primary" disabled={busy} onClick={() => act(`/api/agents/${id}`, { status: 'active' })}>Resume {name}</Button> : (
          <>
            <Button disabled={busy} onClick={() => act(`/api/agents/${id}`, { status: 'paused' })}>{running ? 'Pause after this turn' : 'Pause'}</Button>
            {running && <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Stop ${name} right now? The turn is cut short; its branch and files stay as they are.`)) void act(`/api/agents/${id}/stop`, {}); }}>Stop now</Button>}
          </>
        )}
      </div>
      {status === 'paused' && <Text size="caption" tone="muted">Paused: nothing new starts for {name} until you resume. Queued work waits.</Text>}
      {error && <Text size="small" tone="stop">{error}</Text>}
    </div>
  );
}

// A private conversation: only you and this agent's reply see it. It never reaches the team's discussion, search or chat mirror.
export function DirectMessages({ id, name }: { id: string; name: string }) {
  const view = useResource<Direct>(`/api/agents/${id}/dm`);
  const [text, setText] = useState(''), [error, setError] = useState<string | null>(null);
  useStream(event => event.type === 'message.posted' && (event as { threadId?: string }).threadId === view.data?.threadId, view.reload);
  const send = async () => { if (!text.trim()) return; try { await api(`/api/agents/${id}/dm`, { body: text }); setText(''); setError(null); view.reload(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The message could not be sent'); } };
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Just you and {name}</SectionLabel>
      {view.data?.messages.length === 0 && <StatusLine tone="off">Nobody else can read this, and other agents never see it. {name} replies the next time it is free.</StatusLine>}
      {view.data?.messages.map(message => <div key={message.id} className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{message.authorKind === 'user' ? 'You' : name}</Text><Text size="small" tone="soft">{message.body}</Text></div>)}
      <Textarea rows={2} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(); }} placeholder={`Ask ${name} something, or tell it how you want things done`} />
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div><Button variant="primary" disabled={!text.trim()} onClick={() => { void send(); }}>Send privately</Button></div>
    </div>
  );
}
