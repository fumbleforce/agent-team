import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { StatusLine, usePinnedTail } from '../../patterns';
import { Avatar, Button, Checkbox, Dialog, Input, Text } from '../../ui';
import { useVoice } from './useVoice';

interface Desk { id: string; name: string; title: string; initials: string; tint: string; model: string | null }
interface Direct { threadId: string; messages: { id: string; authorKind: string; body: string; createdAt: number }[] }
const remembered = (key: string) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const remember = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* a convenience only */ } };

// The team's front desk: ask what is going on, typed or spoken, and hear the answer. What is work, it passes to the PM.
// Shown only for a team that has someone at the desk.
export function FrontDesk({ slug }: { slug: string }) {
  const desk = useResource<{ desk: Desk | null }>(`/api/projects/${slug}/desk`).data?.desk ?? null;
  const [open, setOpen] = useState(false);
  if (!desk) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen} title={desk.name} description={desk.title} trigger={<Button size="sm"><Avatar initials={desk.initials} tint={desk.tint} size="xs" />Ask {desk.name}</Button>}>
      {open && <Conversation desk={desk} />}
    </Dialog>
  );
}

function Conversation({ desk }: { desk: Desk }) {
  const view = useResource<Direct>(`/api/agents/${desk.id}/dm`);
  const [text, setText] = useState(''), [waiting, setWaiting] = useState(false), [error, setError] = useState<string | null>(null);
  const [aloud, setAloud] = useState(() => remembered('desk.aloud')), [handsFree, setHandsFree] = useState(false);
  const send = async (body: string) => { if (!body.trim()) return; setText(''); setError(null); setWaiting(true); try { await api(`/api/agents/${desk.id}/dm`, { body }); view.reload(); } catch (failure) { setWaiting(false); setError(failure instanceof ApiError ? failure.message : 'That could not be sent'); } };
  const voice = useVoice(heard => { void send(heard); });
  useStream(event => event.type === 'message.posted' && (event as { threadId?: string }).threadId === view.data?.threadId, view.reload);

  // A new answer ends the wait, is read aloud when asked for, and in a spoken conversation hands the turn back to the person.
  const tail = usePinnedTail();
  const messages = view.data?.messages ?? [], last = messages.at(-1), spoken = useRef<string | null>(null);
  useEffect(() => {
    tail.follow();
    if (!last || last.authorKind === 'user') return;
    if (spoken.current === null) { spoken.current = last.id; return; }
    if (spoken.current === last.id) return;
    spoken.current = last.id; setWaiting(false);
    if (aloud || handsFree) voice.speak(last.body, () => { if (handsFree) voice.listen(); });
  }, [last?.id]);
  useEffect(() => { if (view.data && spoken.current === null) spoken.current = last?.authorKind === 'user' ? '' : last?.id ?? ''; }, [view.data]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div ref={tail.container} onScroll={tail.onScroll} className="flex max-h-80 min-h-24 flex-col gap-2.5 overflow-y-auto">
        {messages.length === 0 && view.data && <Text size="small" tone="muted">Ask what is going on, or say what you need.</Text>}
        {messages.map(message => <div key={message.id} className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{message.authorKind === 'user' ? 'You' : desk.name}</Text><Text size="small" tone={message.authorKind === 'user' ? 'soft' : 'ink'}>{message.body}</Text></div>)}
        {waiting && <StatusLine tone="working" busy>{desk.name} is answering</StatusLine>}
        {voice.listening && <StatusLine tone="working" busy>{voice.hearing || 'Listening…'}</StatusLine>}
      </div>
      {(error ?? voice.problem) && <Text size="small" tone="stop">{error ?? voice.problem}</Text>}
      <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); void send(text); }}>
        <Input value={text} onChange={event => setText(event.target.value)} placeholder={`Ask ${desk.name}`} aria-label={`Ask ${desk.name}`} autoFocus />
        {voice.canListen && <Button aria-pressed={voice.listening} variant={voice.listening ? 'primary' : 'secondary'} onClick={() => { if (voice.listening) voice.stop(); else { voice.hush(); voice.listen(); } }}>{voice.listening ? 'Stop' : 'Speak'}</Button>}
        <Button type="submit" variant="primary" disabled={!text.trim()}>Send</Button>
      </form>
      <div className="flex flex-wrap items-center gap-4">
        {voice.canSpeak && <Checkbox label="Read answers aloud" checked={aloud} onChange={event => { setAloud(event.target.checked); remember('desk.aloud', event.target.checked); if (!event.target.checked) voice.hush(); }} />}
        {voice.canListen && voice.canSpeak && <Checkbox label="Hands-free conversation" checked={handsFree} onChange={event => { setHandsFree(event.target.checked); if (event.target.checked) { voice.hush(); voice.listen(); } else { voice.stop(); voice.hush(); } }} />}
      </div>
    </div>
  );
}
