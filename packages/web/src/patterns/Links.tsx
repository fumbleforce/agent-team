import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Card, Text } from '../ui';

const MARK = { project: '▣', agent: '@', task: '◆', issue: '#', page: '¶', proposal: '△', role: '§' } as const;
export type EntityKind = keyof typeof MARK;

// A reference to something the platform knows, written the same way wherever it appears: a mark for the kind, an optional key, the name.
export function EntityLink({ kind, href, code, children }: { kind: EntityKind; href: string; code?: string | undefined; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex max-w-full items-baseline gap-1 rounded-chip px-1 hover:bg-active">
      <Text size="caption" tone="faint" mono aria-hidden>{MARK[kind]}</Text>
      {code && <Text size="caption" tone="muted" mono>{code}</Text>}
      <Text size="small" tone="accent" truncate>{children}</Text>
    </Link>
  );
}

// What a list or a page says when it has nothing to show: what is missing, why, and the one thing to do about it.
export function EmptyState({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <Card tone="outline" className="flex flex-col items-center gap-2 py-8 text-center">
      <Text as="h2" size="title">{title}</Text>
      {note && <Text size="small" tone="muted" className="max-w-100">{note}</Text>}
      {children && <div className="flex gap-2 pt-1.5">{children}</div>}
    </Card>
  );
}
