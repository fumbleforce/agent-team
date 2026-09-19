import type { ReactNode } from 'react';
import { Chip, cx, StatusDot, Text, type DotTone } from '../ui';

// A large, clickable choice: what a person picks from when setting something up.
export function ChoiceCard({ title, note, aside, onClick }: { title: string; note: string; aside?: ReactNode; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="flex cursor-pointer flex-col gap-1 rounded-card border border-line bg-raised px-3 py-2.5 text-left hover:border-accent hover:bg-active">
      <span className="flex items-center gap-2"><Text weight="semibold">{title}</Text><span className="ml-auto flex items-center gap-1.5">{aside}</span></span>
      <Text size="caption" tone="muted">{note}</Text>
    </button>
  );
}

// Instructions a person follows in order, outside the app.
export function Steps({ items }: { items: string[] }) {
  return <ol className="m-0 flex list-none flex-col gap-2 p-0">{items.map((item, index) => <li key={item} className="flex gap-2.5"><Chip mono>{index + 1}</Chip><Text size="small" tone="soft">{item}</Text></li>)}</ol>;
}

// One line of state with a dot: ready, waiting, or failed.
export function StatusLine({ tone, children, boxed }: { tone: DotTone; children: ReactNode; boxed?: boolean }) {
  return <div className={cx('flex items-start gap-2', boxed && 'rounded-control border border-line bg-raised px-3 py-2')}><span className="pt-1"><StatusDot tone={tone} /></span><Text size="small" tone="soft">{children}</Text></div>;
}
