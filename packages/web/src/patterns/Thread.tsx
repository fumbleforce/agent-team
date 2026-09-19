import { useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { Agent, Message as MessageData } from '../data/client';
import { Avatar, Button, Card, Chip, cx, Icon, Text, Textarea, type ChipTone } from '../ui';
import { Attachment } from './Lanes';
import { Markdown } from './Markdown';

export interface Author { name: string; initials: string; tint: string | 'accent'; role: string }

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const STANCE: Record<string, ChipTone> = { for: 'working', against: 'stop', neutral: 'neutral' };

// The images stored with a message: those attached in the composer, and the one an issue or a handoff was raised with.
// A marked-up product snapshot is left to the view that can draw its markers.
export function attachmentsOf(payload: Record<string, unknown>): string[] {
  const many = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : [], one = Array.isArray(payload.markers) ? null : payload.attachmentId;
  return [...new Set([...many, one].filter((id): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)))];
}

export function resolveAuthor(message: MessageData, roster: Agent[], me: { id: string; name: string }): Author {
  if (message.authorKind === 'agent') {
    const agent = roster.find(item => item.id === message.authorId);
    if (agent) return { name: agent.name, initials: agent.initials, tint: agent.tint, role: agent.title };
  }
  if (message.authorKind === 'user') return { name: message.authorId === me.id ? 'You' : 'Teammate', initials: me.name.slice(0, 2).toUpperCase(), tint: 'accent', role: '' };
  return { name: 'System', initials: '··', tint: '8', role: '' };
}

// One message of a thread. Decisions are the highlighted card; feedback blocks carry a stance chip. Bodies are markdown.
export function Message({ message, author }: { message: MessageData; author: Author }) {
  const stance = typeof message.payload.stance === 'string' ? message.payload.stance : null;
  const images = attachmentsOf(message.payload);
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
        <Markdown size="small">{message.body}</Markdown>
        {images.length > 0 && <div className="flex flex-wrap gap-2 pt-1">{images.map(id => <Attachment key={id} id={id} />)}</div>}
      </div>
    </div>
  );
  return message.kind === 'decision' ? <Card tone="decision" pad="sm">{content}</Card> : content;
}

export interface MentionOption { token: string; label: string; note: string; kind: 'agent' | 'role'; initials?: string; tint?: string }
export interface ComposerImage { id: string; name: string }

const slug = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// What can be mentioned in a team's thread: each agent by first name and each role the team wears.
export function mentionOptions(roster: Agent[]): MentionOption[] {
  const roles = [...new Set(roster.map(agent => agent.title).filter(Boolean))];
  return [
    ...roster.map(agent => ({ token: slug(agent.name.split(/\s+/)[0] ?? agent.name), label: agent.name, note: agent.title, kind: 'agent' as const, initials: agent.initials, tint: agent.tint })),
    ...roles.map(role => ({ token: slug(role), label: role, note: 'everyone in this role', kind: 'role' as const })),
  ].filter(option => option.token);
}

// The @word being typed just before the caret, if any.
const openMention = (text: string, caret: number) => /(?:^|[\s(])@([\w-]{0,40})$/.exec(text.slice(0, caret))?.[1] ?? null;

export interface ComposerProps { placeholder: string; action: string; onSend(body: string, attachmentIds: string[]): Promise<void>; mentions?: MentionOption[]; onAttach?(file: File): Promise<ComposerImage> }

// Message box. `mentions` turns on @ completion; `onAttach` turns on pasting and picking images and returns the stored attachment.
export function Composer({ placeholder, action, onSend, mentions = [], onAttach }: ComposerProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const needle = query?.toLowerCase() ?? '';
  const matches = query === null ? [] : mentions.filter(option => option.token.startsWith(needle) || option.label.toLowerCase().startsWith(needle)).slice(0, 6);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try { await onSend(body.trim(), images.map(image => image.id)); setBody(''); setImages([]); setQuery(null); } finally { setBusy(false); }
  };
  const track = (text: string, caret: number) => { setBody(text); setQuery(mentions.length ? openMention(text, caret) : null); setCursor(0); };
  const complete = (option: MentionOption) => {
    const caret = box.current?.selectionStart ?? body.length;
    const head = body.slice(0, caret).replace(/@[\w-]*$/, `@${option.token} `);
    setBody(head + body.slice(caret));
    setQuery(null);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(head.length, head.length); });
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCursor(value => (value + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return; }
      if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') { event.preventDefault(); complete(matches[cursor] ?? matches[0]!); return; }
      if (event.key === 'Escape') { event.preventDefault(); setQuery(null); return; }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event);
  };
  const attach = async (files: File[]) => {
    if (!onAttach || !files.length) return;
    setBusy(true);
    setProblem(null);
    try { for (const file of files) { const image = await onAttach(file); setImages(current => [...current, image].slice(0, 10)); } }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The image could not be attached.'); }
    finally { setBusy(false); }
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (onAttach && files.length) { event.preventDefault(); void attach(files); }
  };

  return (
    <form onSubmit={submit} className="border-t border-line px-4 pt-3 pb-4">
      <Card tone="raised" pad="sm" className="relative flex flex-col gap-2">
        {matches.length > 0 && (
          <div role="listbox" aria-label="Mention" className="absolute inset-x-0 bottom-full z-10 mb-1 flex flex-col rounded-control border border-line-strong bg-raised p-1 shadow-lg">
            {matches.map((option, index) => (
              <button key={`${option.kind}:${option.token}`} type="button" role="option" aria-selected={index === cursor} onMouseDown={event => { event.preventDefault(); complete(option); }} onMouseEnter={() => setCursor(index)}
                className={cx('flex cursor-pointer items-center gap-2 rounded-chip border-0 px-2 py-1.5 text-left', index === cursor ? 'bg-active' : 'bg-transparent')}>
                {option.kind === 'agent' ? <Avatar initials={option.initials ?? '··'} tint={option.tint ?? '8'} size="xs" /> : <Text size="caption" tone="faint" mono className="w-4 text-center">§</Text>}
                <Text size="small">{option.label}</Text>
                <Text size="caption" tone="muted" mono>@{option.token}</Text>
                <Text size="caption" tone="muted" truncate className="ml-auto">{option.note}</Text>
              </button>
            ))}
          </div>
        )}
        <Textarea ref={box} bare rows={2} aria-label={placeholder} placeholder={placeholder} value={body} onChange={event => track(event.target.value, event.target.selectionStart)} onKeyDown={keys} onPaste={paste} onBlur={() => setQuery(null)} />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map(image => (
              <Chip key={image.id}>
                <Icon name="image" size={11} />{image.name}
                <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages(current => current.filter(item => item.id !== image.id))} className="flex cursor-pointer items-center border-0 bg-transparent p-0 text-ink-muted hover:text-ink"><Icon name="close" size={10} /></button>
              </Chip>
            ))}
          </div>
        )}
        {problem && <Text size="caption" tone="stop">{problem}</Text>}
        <div className="flex items-center gap-1.5">
          {onAttach && <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Image files" onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ''; }} />}
          {onAttach && <Button variant="ghost" size="icon" aria-label="Attach an image" onClick={() => picker.current?.click()}><Icon name="image" /></Button>}
          <Text size="caption" tone="faint" truncate>Ctrl + Enter to send{mentions.length > 0 && ' · @ to mention'}{onAttach && ' · paste an image'}</Text>
          <Button variant="primary" className="ml-auto" type="submit" disabled={busy || !body.trim()}>{action}</Button>
        </div>
      </Card>
    </form>
  );
}
