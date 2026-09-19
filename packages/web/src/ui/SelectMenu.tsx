import { Content, Icon as Chevron, Item, ItemText, Portal, Root, Trigger, Value, Viewport } from '@radix-ui/react-select';
import { cx } from './cx';
import { Icon } from './Icon';
import { FLOATING, OPTION } from './Menu';

export interface SelectOption<T extends string = string> { value: T; label: string; disabled?: boolean }

// The styled listbox; its width follows the trigger, which Radix reports as a variable, hence the one inline style.
// The styled listbox. The native `Select` in Field stays for plain forms that post by name; this one is for pickers in the interface.
export function SelectMenu<T extends string>({ value, onChange, options, label, placeholder, compact, disabled }: { value: T | undefined; onChange(value: T): void; options: SelectOption<T>[]; label: string; placeholder?: string; compact?: boolean; disabled?: boolean }) {
  return (
    <Root {...(value === undefined ? {} : { value })} onValueChange={next => onChange(next as T)} disabled={disabled ?? false}>
      <Trigger aria-label={label} className={cx('inline-flex cursor-pointer items-center justify-between gap-2 rounded-control border border-line-strong outline-none focus:border-accent disabled:opacity-50 data-placeholder:text-ink-faint', compact ? 'h-6 bg-ground px-1.5 text-caption text-ink-soft' : 'h-9 w-full bg-raised px-3 text-body text-ink')}>
        <Value placeholder={placeholder ?? ''} />
        <Chevron className="text-ink-muted"><Icon name="chevron" size={12} /></Chevron>
      </Trigger>
      <Portal>
        <Content position="popper" sideOffset={4} className={cx(FLOATING, 'max-h-72 overflow-hidden')} style={{ minWidth: 'var(--radix-select-trigger-width)' }}>
          <Viewport>
            {options.map(option => <Item key={option.value} value={option.value} disabled={option.disabled ?? false} className={cx(OPTION, 'text-ink-soft')}><ItemText>{option.label}</ItemText></Item>)}
          </Viewport>
        </Content>
      </Portal>
    </Root>
  );
}
