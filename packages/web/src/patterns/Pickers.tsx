import { useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, Chip, Field, Input, Spinner, Text } from '../ui';

export interface PickOption { id: string; name: string; note?: string }

// Choose several from a list that may be long: what is chosen stays on top as chips, the rest is found by typing.
// A name the list does not have can be added as typed. The choice travels in a hidden input, one per line.
// `inline` is the picker inside a row of a page: the list only opens while someone is looking for something.
export function MultiPicker({ name, label, options, value, onChange, loading, error, inline, disabled }: { name: string; label: string; options: PickOption[]; value: string[]; onChange(next: string[]): void; loading?: boolean; error?: string | undefined; inline?: boolean; disabled?: boolean }) {
  const [query, setQuery] = useState(''), [looking, setLooking] = useState(false);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => options.filter(option => words.every(word => `${option.id} ${option.name}`.toLowerCase().includes(word))).slice(0, 60), [options, query]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const typed = query.trim(), addable = typed && !/\s/.test(typed) && !value.includes(typed) && !options.some(option => option.id === typed);
  const open = !inline || looking;
  return (
    <div className="flex flex-col gap-1.5" onFocus={() => setLooking(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setLooking(false); setQuery(''); } }}>
      {!inline && <Text size="small" tone="muted">{label}</Text>}
      <input type="hidden" name={name} value={value.join('\n')} />
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map(id => <button key={id} type="button" disabled={disabled} onClick={() => toggle(id)} aria-label={`Remove ${id}`} className="cursor-pointer disabled:cursor-default"><Chip tone="working">{options.find(option => option.id === id)?.name ?? id}{!disabled && ' ×'}</Chip></button>)}
        {inline && !disabled && <span className="w-44"><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="+ Add a model" aria-label={`Search ${label}`} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (addable) { toggle(typed); setQuery(''); } } if (event.key === 'Escape') event.currentTarget.blur(); }} /></span>}
      </div>
      {!inline && <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={options.length > 6 ? 'Search models' : 'Add a model by name'} aria-label={`Search ${label}`} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (addable) { toggle(typed); setQuery(''); } } }} />}
      {open && !disabled && (
        <div onMouseDown={event => { if (inline) event.preventDefault(); }} className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-control border border-line bg-raised px-3 py-2.5">
          {loading && <span className="flex items-center gap-2"><Spinner /><Text size="small" tone="muted">Loading the list…</Text></span>}
          {shown.map(option => <Checkbox key={option.id} label={option.name} {...(option.note ? { note: option.note } : {})} checked={value.includes(option.id)} onChange={() => toggle(option.id)} />)}
          {addable && <div><Button size="sm" onClick={() => { toggle(typed); setQuery(''); }}>Add “{typed}”</Button></div>}
          {!loading && shown.length === 0 && !addable && <Text size="small" tone="muted">{options.length ? 'Nothing matches.' : 'Type a model name and press Enter.'}</Text>}
        </div>
      )}
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
