import type { ReactNode } from 'react';
import { Chip, cx, Icon, Spinner, StatusDot, Text, type DotTone } from '../ui';

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
// The mark sits in a box as tall as one line of the text, so it lines up with the first line however long the sentence is.
// `busy` swaps the dot for a spinner: the thing described is going on right now.
export function StatusLine({ tone, children, boxed, busy }: { tone: DotTone; children: ReactNode; boxed?: boolean; busy?: boolean }) {
  return <div className={cx('flex items-start gap-2', boxed && 'rounded-control border border-line bg-raised px-3 py-2')}><span className="flex h-4.5 w-3 shrink-0 items-center justify-center">{busy ? <Spinner /> : <StatusDot tone={tone} />}</span><Text size="small" tone="soft">{children}</Text></div>;
}

// One step of a guide. The current step is open; a finished one collapses to a line saying what was done; later ones wait.
export function StepCard({ number, title, note, state, optional, locked, children }: { number: number; title: string; note: string; state: 'done' | 'current' | 'later'; optional: boolean; locked?: boolean; children: ReactNode }) {
  const open = !locked && state !== 'done' && (state === 'current' || optional);
  return (
    <section aria-label={title} className={cx('flex gap-3 rounded-card border px-4 py-3.5', state === 'current' ? 'border-accent bg-card' : 'border-line bg-raised', locked && 'opacity-60')}>
      <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-pill text-caption font-semibold', state === 'done' ? 'bg-working-wash text-working-ink' : state === 'current' ? 'bg-accent text-on-accent' : 'bg-active text-ink-muted')}>{state === 'done' ? <Icon name="check" /> : number}</span>
      <div className="flex min-w-0 grow flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2"><Text weight="semibold" tone={state === 'later' ? 'soft' : 'ink'}>{title}</Text>{optional && state !== 'done' && <Chip>Optional</Chip>}</span>
          <Text size="small" tone="muted">{note}</Text>
        </div>
        {open && <div className="flex flex-col items-start gap-3">{children}</div>}
        {!open && !locked && state === 'later' && <details className="group"><summary className="cursor-pointer list-none text-small text-accent">Do this now</summary><div className="flex flex-col items-start gap-3 pt-2.5">{children}</div></details>}
      </div>
    </section>
  );
}
