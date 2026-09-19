import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Card, Chip, cx, Meter, Text } from '../ui';
import { Markdown } from './Markdown';

export function SidePanel({ label, side = 'left', wide, children }: { label: string; side?: 'left' | 'right'; wide?: boolean; children: ReactNode }) {
  return <aside aria-label={label} className={cx('flex shrink-0 flex-col gap-0.5 overflow-y-auto bg-rail px-2.5 py-3.5', wide ? 'w-85' : 'w-65', side === 'left' ? 'border-r border-line' : 'border-l border-line')}>{children}</aside>;
}

export function ListLink({ href, active, indent, mark, children, aside }: { href: string; active?: boolean; indent?: boolean; mark?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Link href={href} className={cx('flex items-center gap-2 rounded-control py-1.5 pr-2 hover:bg-active', indent ? 'pl-6.5' : 'pl-2', active && 'bg-active')}>
      {mark && <Text size="caption" tone="faint" mono>{mark}</Text>}
      <Text size="small" tone={active ? 'ink' : 'soft'} weight={active ? 'medium' : 'regular'} truncate>{children}</Text>
      {aside && <span className="ml-auto">{aside}</span>}
    </Link>
  );
}

// Article body: a knowledge page's markdown, rendered and sanitized by Markdown.
export function Prose({ children }: { children: string }) {
  return <Markdown className="max-w-180">{children}</Markdown>;
}

export function NoteCard({ children, meta, tag }: { children: ReactNode; meta: ReactNode; tag?: string }) {
  return <Card tone="raised" pad="sm" className="flex flex-col gap-1.5"><Text size="small" tone="soft">{children}</Text><div className="flex items-center gap-1.5"><Text size="caption" tone="muted">{meta}</Text>{tag && <span className="ml-auto"><Chip>{tag}</Chip></span>}</div></Card>;
}

export function BarRow({ label, value, share, note, indent }: { label: ReactNode; value: string; share: number; note?: string; indent?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Text size="small" truncate className={cx('w-28 shrink-0', indent && 'pl-3.5')}>{label}</Text>
      <Meter value={share} tone="review" />
      <Text size="caption" mono className="w-14 shrink-0 text-right">{value}</Text>
      <Text size="caption" tone="muted" mono className="w-16 shrink-0 text-right">{note}</Text>
    </div>
  );
}

const KIND_MARK: Record<string, { mark: string; tone: 'neutral' | 'working' | 'review' | 'attention' }> = { read: { mark: 'R', tone: 'neutral' }, edit: { mark: 'E', tone: 'working' }, run: { mark: '$', tone: 'review' }, think: { mark: '…', tone: 'neutral' }, message: { mark: '@', tone: 'attention' } };

export function TraceRow({ at, kind, title, detail }: { at: number; kind: string; title: string; detail: string | null }) {
  const mark = KIND_MARK[kind] ?? KIND_MARK.think!;
  return (
    <div className="flex items-start gap-2.5 rounded-control px-2 py-1.5">
      <Text size="caption" tone="faint" mono className="w-14 shrink-0">{new Date(at).toLocaleTimeString([], { hour12: false })}</Text>
      <Chip tone={mark.tone} mono>{mark.mark}</Chip>
      <Text size="small" className="min-w-0">{title}</Text>
      {detail && <Text size="caption" tone="muted" mono className="ml-auto shrink-0 whitespace-nowrap">{detail}</Text>}
    </div>
  );
}
