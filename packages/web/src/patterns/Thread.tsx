import { useState, type FormEvent } from 'react';
import type { Agent, Message as MessageData } from '../data/client';
import { Avatar, Button, Card, Chip, Icon, Text, Textarea, type ChipTone } from '../ui';

export interface Author { name: string; initials: string; tint: string | 'accent'; role: string }

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const STANCE: Record<string, ChipTone> = { for: 'working', against: 'stop', neutral: 'neutral' };

export function resolveAuthor(message: MessageData, roster: Agent[], me: { id: string; name: string }): Author {
  if (message.authorKind === 'agent') {
    const agent = roster.find(item => item.id === message.authorId);
    if (agent) return { name: agent.name, initials: agent.initials, tint: agent.tint, role: agent.title };
  }
  if (message.authorKind === 'user') return { name: message.authorId === me.id ? 'You' : 'Teammate', initials: me.name.slice(0, 2).toUpperCase(), tint: 'accent', role: '' };
  return { name: 'System', initials: '··', tint: '8', role: '' };
}

// One message of a thread. Decisions are the highlighted card; feedback blocks carry a stance chip.
export function Message({ message, author }: { message: MessageData; author: Author }) {
  const stance = typeof message.payload.stance === 'string' ? message.payload.stance : null;
  const content = (
    <div className="flex items-start gap-2.5">
      <Avatar initials={author.initials} tint={author.tint} size="sm" />
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <Text size="small" weight="semibold">{author.name}</Text>
          <Text size="caption" tone="muted">{author.role}</Text>
          {stance && <Chip tone={STANCE[stance] ?? 'neutral'}>{stance}</Chip>}
          <Text size="caption" tone="faint" mono className="ml-auto">{time(message.createdAt)}</Text>
        </div>
        {message.kind === 'decision' && <span className="flex items-center gap-1"><Text size="label" tone="accent"><Icon name="check" size={11} /></Text><Text size="label" tone="accent">Decision</Text></span>}
        {message.kind === 'proposal' && <Text size="label">Proposal</Text>}
        <Text as="p" size="small" tone="soft" className="m-0 whitespace-pre-wrap">{message.body}</Text>
      </div>
    </div>
  );
  return message.kind === 'decision' ? <Card tone="decision" pad="sm">{content}</Card> : content;
}

export function Composer({ placeholder, action, onSend }: { placeholder: string; action: string; onSend(body: string): Promise<void> }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try { await onSend(body.trim()); setBody(''); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="border-t border-line px-4 pt-3 pb-4">
      <Card tone="raised" pad="sm" className="flex flex-col gap-2">
        <Textarea bare rows={2} aria-label={placeholder} placeholder={placeholder} value={body} onChange={event => setBody(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event); }} />
        <div className="flex items-center gap-1">
          <Text size="caption" tone="faint">Ctrl + Enter to send</Text>
          <Button variant="primary" className="ml-auto" type="submit" disabled={busy || !body.trim()}>{action}</Button>
        </div>
      </Card>
    </form>
  );
}
