import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { cx } from './cx';
import { Text } from './Text';

const ROW = 'flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left';

// One line of a list: something in front, a title with an optional note under it, something at the end.
// A link with `href`, a button with `onClick`, otherwise plain.
export function ListRow({ leading, title, note, aside, active, href, onClick }: { leading?: ReactNode; title: ReactNode; note?: ReactNode; aside?: ReactNode; active?: boolean; href?: string; onClick?(): void }) {
  const content = (
    <>
      {leading}
      <span className="flex min-w-0 grow flex-col">
        <Text size="small" weight={active ? 'medium' : 'regular'} tone={active ? 'ink' : 'soft'} truncate>{title}</Text>
        {note && <Text size="caption" tone="muted" truncate>{note}</Text>}
      </span>
      {aside && <span className="ml-auto shrink-0">{aside}</span>}
    </>
  );
  const interactive = cx(ROW, 'cursor-pointer hover:bg-active', active && 'bg-active');
  if (href) return <Link href={href} aria-current={active ? 'page' : undefined} className={interactive}>{content}</Link>;
  if (onClick) return <button type="button" onClick={onClick} aria-pressed={active ?? false} className={cx(interactive, 'border-0 bg-transparent')}>{content}</button>;
  return <div className={cx(ROW, active && 'bg-active')}>{content}</div>;
}
