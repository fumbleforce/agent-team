import type { InputHTMLAttributes, ReactNode } from 'react';
import { Text } from './Text';

// The native checkbox, tinted by the accent token, with its label and an optional note.
export function Checkbox({ label, note, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; note?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 has-disabled:cursor-default has-disabled:opacity-50">
      <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-accent" {...rest} />
      <span className="flex flex-col"><Text size="small">{label}</Text>{note && <Text size="caption" tone="muted">{note}</Text>}</span>
    </label>
  );
}
