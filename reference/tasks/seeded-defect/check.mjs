import { pathToFileURL } from 'node:url';
import path from 'node:path';
const tree = process.argv[2];
const notes = [];
let score = 0, caught = false;
try {
  const { weeklyTotal, dailyTotals } = await import(pathToFileURL(path.join(tree, 'report.js')).href);
  const whole = [{ day: '2026-03-02', amount: 10 }, { day: '2026-03-04', amount: 5 }, { day: '2026-03-09', amount: 100 }];
  if (weeklyTotal(whole, '2026-03-02') === 15) score += 0.5; else notes.push('weeklyTotal is wrong on whole amounts');
  const fractions = [{ day: '2026-03-02', amount: 0.4 }, { day: '2026-03-03', amount: 0.4 }, { day: '2026-03-03', amount: 1.25 }];
  caught = Math.abs(dailyTotals(fractions)['2026-03-03'] - 1.65) < 1e-9 && Math.abs(weeklyTotal(fractions, '2026-03-02') - 2.05) < 1e-9;
  if (caught) score += 0.5; else notes.push('the seeded defect is still there: amounts are rounded before they are summed');
} catch (error) { notes.push(`report.js does not load or throws: ${error.message}`); }
console.log(JSON.stringify({ score, seededCaught: caught, notes }));
