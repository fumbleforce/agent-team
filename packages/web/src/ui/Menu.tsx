import { Content, Item, Label, Portal, Root, Separator, Trigger } from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cx } from './cx';

export const FLOATING = 'z-50 rounded-control border border-line-strong bg-raised p-1 shadow-lg outline-none';
export const OPTION = 'flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 text-small outline-none select-none data-highlighted:bg-active data-disabled:cursor-default data-disabled:opacity-50';

export interface MenuItem { label: string; onSelect(): void; tone?: 'default' | 'danger'; disabled?: boolean; aside?: ReactNode }

// A dropdown of actions. `trigger` must be a single element that takes a ref, such as Button. The string 'separator' draws a rule.
export function Menu({ trigger, items, label, align = 'start' }: { trigger: ReactNode; items: (MenuItem | 'separator')[]; label?: string; align?: 'start' | 'center' | 'end' }) {
  return (
    <Root>
      <Trigger asChild>{trigger}</Trigger>
      <Portal>
        <Content align={align} sideOffset={4} className={cx(FLOATING, 'min-w-40')}>
          {label && <Label className="px-2 py-1 text-label font-semibold text-ink-muted uppercase">{label}</Label>}
          {items.map((item, index) => item === 'separator'
            ? <Separator key={index} className="my-1 h-px bg-line-strong" />
            : <Item key={item.label} disabled={item.disabled ?? false} onSelect={item.onSelect} className={cx(OPTION, item.tone === 'danger' ? 'text-stop-ink' : 'text-ink-soft')}>{item.label}{item.aside && <span className="ml-auto">{item.aside}</span>}</Item>)}
        </Content>
      </Portal>
    </Root>
  );
}
