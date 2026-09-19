import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { Text } from './Text';

const BOX = 'w-full rounded-control border border-line-strong bg-raised px-3 text-body text-ink placeholder:text-ink-faint outline-none focus:border-accent';

export function Field({ label, help, error, children }: { label: string; help?: string | undefined; error?: string | undefined; children: ReactNode }) {
  return <label className="flex flex-col gap-1.5"><Text size="small" tone="muted">{label}</Text>{children}{error ? <Text size="caption" tone="stop">{error}</Text> : help && <Text size="caption" tone="faint">{help}</Text>}</label>;
}
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input className={cx(BOX, 'h-9', className)} {...rest} />; }
export function Textarea({ className, bare, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { bare?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cx(bare ? 'w-full resize-none bg-transparent text-body text-ink placeholder:text-ink-faint outline-none' : cx(BOX, 'py-2 resize-none'), className)} {...rest} />;
}
export function Select({ className, compact, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return <select className={cx(compact ? 'h-6 cursor-pointer rounded-control border border-line-strong bg-ground px-1.5 text-caption text-ink-soft outline-none focus:border-accent' : cx(BOX, 'h-9'), className)} {...rest} />;
}
