import { formatFigure, type Group, type Scorecard } from './scorecard.ts';

const TITLES: Record<Group, string> = {
  'team-vs-one': 'The team against one model',
  'self-improving': 'A team that improves itself',
  autonomy: 'Autonomy',
  performance: 'Performance',
  delivery: 'Delivery',
  observability: 'Observability',
  safety: 'Safety',
};

// The scorecard as text for a terminal: one line per figure, with whether its target is met and what it was counted over.
export function printScorecard(card: Scorecard, project: string): string {
  const days = Math.round((card.to - card.from) / (24 * 3600_000));
  const lines = [`Scorecard for ${project}, last ${days} days`];
  let group: Group | null = null;
  for (const item of card.figures) {
    if (item.group !== group) {
      group = item.group;
      lines.push('', TITLES[group]);
    }
    const mark = item.met === null ? ' ' : item.met ? '✓' : '✗';
    const counted = item.value === null ? '' : `  (over ${item.sample})`;
    lines.push(`  ${mark} ${item.id.padEnd(3)} ${item.measure.padEnd(58)} ${formatFigure(item).padStart(12)}   target ${item.target}${counted}`);
    if (item.note) lines.push(`        ${item.note}`);
  }
  return lines.join('\n');
}
