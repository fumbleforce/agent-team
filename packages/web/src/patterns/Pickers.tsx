import { useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, Chip, Field, Input, Spinner, Text } from '../ui';

export interface PickOption { id: string; name: string; note?: string }

// Choose several from a list that may be long: what is chosen stays on top as chips, the rest is found by typing.
// `custom` lets a name be added that the list does not have. The choice travels in a hidden input, one per line.
export function MultiPicker({ name, label, options, value, onChange, loading, custom, error }: { name: string; label: string; options: PickOption[]; value: string[]; onChange(next: string[]): void; loading?: boolean; custom?: boolean; error?: string | undefined }) {
  const [query, setQuery] = useState('');
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => options.filter(option => words.every(word => `${option.id} ${option.name}`.toLowerCase().includes(word))).slice(0, 60), [options, query]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const typed = query.trim(), addable = custom && typed && !/\s/.test(typed) && !value.includes(typed) && !options.some(option => option.id === typed);
  return (
    <div className="flex flex-col gap-1.5">
      <Text size="small" tone="muted">{label}</Text>
      <input type="hidden" name={name} value={value.join('\n')} />
      {value.length > 0 && <div className="flex flex-wrap gap-1.5">{value.map(id => <button key={id} type="button" onClick={() => toggle(id)} aria-label={`Remove ${id}`} className="cursor-pointer"><Chip tone="working">{options.find(option => option.id === id)?.name ?? id} ×</Chip></button>)}</div>}
      {(options.length > 6 || custom) && <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={custom && options.length <= 6 ? 'Add a model by name' : 'Search models'} aria-label={`Search ${label}`} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (addable) { toggle(typed); setQuery(''); } } }} />}
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-control border border-line bg-raised px-3 py-2.5">
        {loading && <span className="flex items-center gap-2"><Spinner /><Text size="small" tone="muted">Loading the list…</Text></span>}
        {shown.map(option => <Checkbox key={option.id} label={option.name} {...(option.note ? { note: option.note } : {})} checked={value.includes(option.id)} onChange={() => toggle(option.id)} />)}
        {addable && <div><Button size="sm" onClick={() => { toggle(typed); setQuery(''); }}>Add “{typed}”</Button></div>}
        {!loading && shown.length === 0 && !addable && <Text size="small" tone="muted">Nothing matches.</Text>}
      </div>
      {error && <Text size="caption" tone="stop">{error}</Text>}
    </div>
  );
}

// A key or token typed into the app. Once saved it is never shown again: the field says so and offers to replace it.
export function SecretField({ name, label, saved, getAt, placeholder, error, required }: { name: string; label: string; saved: boolean; getAt?: string | undefined; placeholder?: string | undefined; error?: string | undefined; required?: boolean }) {
  const [replacing, setReplacing] = useState(false);
  if (saved && !replacing) return <div className="flex items-center gap-2"><Chip tone="working">{label} saved</Chip><Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>Replace</Button></div>;
  return (
    <Field label={label} error={error}>
      <Input name={name} type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} required={required && !saved} />
      {getAt && <a href={getAt} target="_blank" rel="noreferrer noopener" className="text-caption text-accent">Get one ↗</a>}
    </Field>
  );
}

// What few people need, folded away under one word.
export function More({ label, children }: { label: string; children: ReactNode }) {
  return <details className="group"><summary className="cursor-pointer list-none text-small text-accent">{label}</summary><div className="flex flex-col gap-3 pt-2.5">{children}</div></details>;
}
