// Sums the amounts of entries ({ day: 'YYYY-MM-DD', amount: number }) per day.
export function dailyTotals(entries) {
  const totals = {};
  for (const entry of entries) {
    totals[entry.day] = (totals[entry.day] ?? 0) + Math.round(entry.amount);
  }
  return totals;
}
