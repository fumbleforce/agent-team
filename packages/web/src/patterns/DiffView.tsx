import type { ReactNode } from 'react';
import { Chip, cx, Text, type Tone } from '../ui';

// A unified diff as git wrote it, read line by line. Nothing here computes a diff: the worker asked git and the text is shown as is.
type LineKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'context';
export interface DiffLine { kind: LineKind; text: string; before: number | null; after: number | null }
export interface DiffFile { path: string; added: number; removed: number; lines: DiffLine[] }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const META = /^(index |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary files|--- |\+\+\+ |\\ )/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let before = 0, after = 0, inHunk = false;
  for (const raw of text.split('\n')) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
    if (header) { files.push({ path: header[2]!, added: 0, removed: 0, lines: [] }); inHunk = false; continue; }
    const file = files.at(-1);
    if (!file) continue;
    const hunk = HUNK.exec(raw);
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); inHunk = true; file.lines.push({ kind: 'hunk', text: raw, before: null, after: null }); }
    else if (!inHunk || raw.startsWith('\\')) { if (META.test(raw)) file.lines.push({ kind: 'meta', text: raw, before: null, after: null }); }
    else if (raw.startsWith('+')) { file.added++; file.lines.push({ kind: 'add', text: raw.slice(1), before: null, after: after++ }); }
    else if (raw.startsWith('-')) { file.removed++; file.lines.push({ kind: 'del', text: raw.slice(1), before: before++, after: null }); }
    else if (raw.startsWith(' ')) file.lines.push({ kind: 'context', text: raw.slice(1), before: before++, after: after++ });
  }
  return files;
}

const ROW: Record<LineKind, string> = { file: '', meta: '', hunk: 'bg-review-wash', add: 'bg-working-wash', del: 'bg-stop-wash', context: '' };
const TONE: Record<LineKind, Tone> = { file: 'ink', meta: 'faint', hunk: 'review', add: 'working', del: 'stop', context: 'soft' };
const SIGN: Record<LineKind, string> = { file: '', meta: '', hunk: '', add: '+', del: '-', context: ' ' };

function Gutter({ value }: { value: number | null }) {
  return <Text size="caption" tone="faint" mono className="w-9 shrink-0 select-none pr-1.5 text-right">{value ?? ''}</Text>;
}

// `plain` is for readers who are not looking at code: the file header, git's bookkeeping lines and hunk positions are left out, and a gap between two changed places is a thin rule.
export function DiffView({ text, truncated, plain }: { text: string; truncated?: boolean; plain?: boolean }) {
  const files = parseDiff(text);
  if (files.length === 0) return <Text size="small" tone="muted">No textual changes.</Text>;
  return (
    <div className="flex flex-col gap-2">
      {files.map(file => (
        <div key={file.path} className="overflow-hidden rounded-control border border-line bg-ground">
          {!plain && <div className="flex items-center gap-2 border-b border-line bg-raised px-2.5 py-1.5">
            <Text size="small" mono truncate>{file.path}</Text>
            <span className="ml-auto flex shrink-0 items-center gap-1"><Chip tone="working" mono>+{file.added}</Chip><Chip tone="stop" mono>-{file.removed}</Chip></span>
          </div>}
          <div role="table" aria-label={`Changes to ${file.path}`} className="overflow-x-auto py-1">
            {file.lines.map((line, index) => (plain && line.kind === 'meta' ? null : plain && line.kind === 'hunk' ? (index > 3 ? <div key={index} className="my-1 border-t border-line" /> : null) : (
              <div role="row" key={index} className={cx('flex items-start', !plain && 'min-w-max', ROW[line.kind])}>
                {line.kind === 'hunk' || line.kind === 'meta' ? <span className="w-18 shrink-0" /> : <><Gutter value={line.before} /><Gutter value={line.after} /></>}
                <Text size="caption" tone={TONE[line.kind]} mono className="w-4 shrink-0 select-none text-center">{SIGN[line.kind]}</Text>
                <Text size="caption" tone={TONE[line.kind]} mono className={cx('pr-3', plain ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre')}>{line.text || ' '}</Text>
              </div>
            )))}
          </div>
        </div>
      ))}
      {truncated && <Text size="caption" tone="attention">The diff was longer than the limit; the rest was cut on the worker.</Text>}
    </div>
  );
}

// Run output and think text: the same frame, no diff colours.
export function OutputView({ text, truncated }: { text: string; truncated?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-control border border-line bg-ground px-2.5 py-2"><Text as="pre" size="caption" tone="soft" mono className="whitespace-pre-wrap">{text}</Text></div>
      {truncated && <Text size="caption" tone="attention">Cut at the limit on the worker.</Text>}
    </div>
  );
}

// A trace row that opens onto what the step produced. The row itself is whatever the caller passes; this adds the disclosure.
export function Disclosure({ open, onToggle, label, row, children }: { open: boolean; onToggle(): void; label: string; row: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} aria-label={label} onClick={onToggle} className={cx('w-full cursor-pointer rounded-control text-left hover:bg-active focus-visible:outline-2 focus-visible:outline-accent', open && 'bg-active')}>{row}</button>
      {open && <div className="py-1.5 pr-2 pl-18">{children}</div>}
    </div>
  );
}
