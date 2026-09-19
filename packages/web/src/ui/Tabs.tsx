import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { cx } from './cx';

export interface TabItem { href: string; label: string; badge?: ReactNode; active?: boolean }

export function Tabs({ items }: { items: TabItem[] }) {
  return (
    <nav className="-ml-2.5 flex gap-0.5">
      {items.map(item => (
        <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined}
          className={cx('flex h-8.5 items-center gap-1.5 border-b-2 px-2.5 text-small', item.active ? 'border-accent font-semibold text-ink' : 'border-transparent font-medium text-ink-soft hover:text-ink')}>
          {item.label}{item.badge}
        </Link>
      ))}
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
