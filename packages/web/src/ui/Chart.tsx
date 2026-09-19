import { Text } from './Text';

// Bar heights are data, so this is one of the few places an inline style is right.
export function ColumnChart({ points }: { points: { label: string; value: number; caption?: string }[] }) {
  const max = Math.max(1, ...points.map(point => point.value));
  return (
    <div className="flex min-h-40 grow flex-col gap-1.5">
      <div className="flex grow items-end gap-1.5 border-b border-line-strong">
        {points.map(point => (
          <div key={point.label} className="flex h-full grow flex-col items-center justify-end gap-1" title={`${point.label}: ${point.caption ?? point.value}`}>
            <div className="w-full rounded-t-chip bg-review-ink" style={{ height: `${(point.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">{points.map(point => <Text key={point.label} size="caption" tone="faint" mono className="grow text-center">{point.label}</Text>)}</div>
    </div>
  );
}
