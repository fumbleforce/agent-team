import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { cx } from './cx';
import { Icon } from './Icon';

// `external` marks a tab that leaves the app: it opens its address in a new browser tab and is never the current page.
export interface TabItem { href: string; label: string; badge?: ReactNode; active?: boolean; external?: boolean }

const TAB = 'flex h-8.5 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-small';
const RESTING = 'border-transparent font-medium text-ink-soft hover:text-ink';

export function Tabs({ items }: { items: TabItem[] }) {
  return (
    <nav className="-ml-2.5 flex gap-0.5 overflow-x-auto">
      {items.map(item => (item.external
        ? <a key={item.href} href={item.href} target="_blank" rel="noreferrer noopener" className={cx(TAB, RESTING)}>{item.label}<Icon name="link" size={11} /><span className="sr-only">opens in a new tab</span></a>
        : (
          <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined} className={cx(TAB, item.active ? 'border-accent font-semibold text-ink' : RESTING)}>
            {item.label}{item.badge}
          </Link>
        )))}
    </nav>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange(value: T): void }) {
  return (
    <div role="radiogroup" className="flex overflow-hidden rounded-control border border-line-strong">
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}
          className={cx('h-7.5 cursor-pointer px-3 text-small', option.value === value ? 'bg-active font-medium text-ink' : 'text-ink-muted hover:text-ink')}>{option.label}</button>
      ))}
    </div>
  );
}
