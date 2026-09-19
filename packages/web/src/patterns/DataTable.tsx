import type { ReactNode } from 'react';
import { Card, cx, SectionLabel, Text } from '../ui';

const WIDTH = { sm: 'w-28 shrink-0', md: 'w-44 shrink-0', lg: 'w-64 shrink-0', grow: 'min-w-40 grow basis-0' } as const;
export interface DataColumn<T> { label: string; width?: keyof typeof WIDTH; cell(row: T): ReactNode }

// Rows of records under one header line: members, audit entries, credentials. Cells are whatever the feature composes from ui/.
export function DataTable<T>({ columns, rows, rowKey, empty }: { columns: DataColumn<T>[]; rows: T[]; rowKey(row: T): string | number; empty?: ReactNode }) {
  return (
    <Card pad="none" className="overflow-x-auto">
      <div role="table" className="flex min-w-max flex-col">
        <div role="row" className="flex items-center gap-3 border-b border-line px-3.5 py-2">
          {columns.map(column => <div key={column.label} role="columnheader" className={WIDTH[column.width ?? 'md']}><SectionLabel>{column.label}</SectionLabel></div>)}
        </div>
        {rows.map(row => (
          <div key={rowKey(row)} role="row" className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
            {columns.map(column => <div key={column.label} role="cell" className={cx('flex min-w-0 items-center gap-1.5', WIDTH[column.width ?? 'md'])}>{column.cell(row)}</div>)}
          </div>
        ))}
        {rows.length === 0 && empty && <div className="px-3.5 py-5">{empty}</div>}
      </div>
    </Card>
  );
}

// A settings page body: one readable column of sections.
export function SettingsBody({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 grow flex-col gap-6 overflow-y-auto px-5 pt-4 pb-8">{children}</div>;
}
export function SettingsSection({ title, note, aside, children }: { title: string; note?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex max-w-240 flex-col gap-2.5">
      <SectionLabel aside={aside}>{title}</SectionLabel>
      {note && <Text size="small" tone="muted">{note}</Text>}
      {children}
    </section>
  );
}
