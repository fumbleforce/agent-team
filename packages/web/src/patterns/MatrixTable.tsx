import { Card, SectionLabel, StatusDot, Text, type DotTone } from '../ui';

export interface MatrixCell { tone: DotTone; text: string }

// Rows by columns with a status dot per cell: test suites per branch, stages per production, checks per domain.
export function MatrixTable({ rowLabel, columns, rows }: { rowLabel: string; columns: string[]; rows: { label: string; aside?: string; cells: (MatrixCell | null)[] }[] }) {
  return (
    <Card pad="none" className="overflow-x-auto">
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-2">
        <div className="w-56 shrink-0"><SectionLabel>{rowLabel}</SectionLabel></div>
        {columns.map(column => <div key={column} className="w-32 shrink-0"><SectionLabel>{column}</SectionLabel></div>)}
        <div className="ml-auto"><SectionLabel>Last run</SectionLabel></div>
      </div>
      {rows.map(row => (
        <div key={row.label} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
          <Text size="small" mono truncate className="w-56 shrink-0">{row.label}</Text>
          {row.cells.map((cell, index) => (
            <div key={columns[index]} className="flex w-32 shrink-0 items-center gap-1.5">
              {cell ? <><StatusDot tone={cell.tone} /><Text size="caption" mono tone={cell.tone === 'stop' ? 'stop' : 'soft'}>{cell.text}</Text></> : <Text size="caption" tone="faint">—</Text>}
            </div>
          ))}
          <Text size="caption" tone="muted" mono className="ml-auto whitespace-nowrap">{row.aside}</Text>
        </div>
      ))}
    </Card>
  );
}
