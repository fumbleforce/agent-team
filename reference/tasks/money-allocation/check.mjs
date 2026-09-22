import { pathToFileURL } from 'node:url';
import path from 'node:path';
const tree = process.argv[2];
const load = file => import(pathToFileURL(path.join(tree, file)).href);
const notes = [], checks = [];
const check = (name, run) => checks.push([name, run]);
const throws = run => { try { run(); return false; } catch { return true; } };
let m, inv, tax, rep;
try { m = await load('money.js'); inv = await load('invoice.js'); tax = await load('tax.js'); rep = await load('report.js'); } catch (error) { notes.push(`does not load: ${error.message}`); }
if (m && inv && tax && rep) {
  // The task leaves the representation free, so everything is judged through what comes out as text or as a sum.
  const show = value => rep.summary({ lines: [{ price: value }] });
  const mk = (amount, currency) => (m.money.length >= 2 || true ? m.money(amount, currency) : m.money(amount));
  const sumOf = parts => rep.summary({ lines: parts.map(price => ({ price })) });
  check('0.1 + 0.2 is 0.30', () => sumOf([mk('0.10', 'EUR'), mk('0.20', 'EUR')]) === 'EUR 0.30');
  check('a long run of cents does not drift', () => sumOf(Array.from({ length: 1000 }, () => mk('0.01', 'EUR'))) === 'EUR 10.00');
  check('JPY has no decimals', () => show(mk('1200', 'JPY')) === 'JPY 1200');
  check('KWD has three', () => show(mk('1.250', 'KWD')) === 'KWD 1.250');
  check('too many decimals is an error', () => throws(() => mk('1.005', 'EUR')) && throws(() => mk('10.5', 'JPY')));
  check('currencies do not mix', () => throws(() => inv.total([{ price: mk('1.00', 'EUR') }, { price: mk('100', 'JPY') }])));
  const parts = (amount, currency, weights) => inv.splitByShare({ lines: [{ price: mk(amount, currency) }] }, weights);
  check('100.00 in three is 33.34, 33.33, 33.33 and adds up', () => { const p = parts('100.00', 'EUR', [1, 1, 1]); return sumOf(p) === 'EUR 100.00' && p.map(show).sort().join() === ['EUR 33.33', 'EUR 33.33', 'EUR 33.34'].sort().join(); });
  check('0.05 by 3:7 adds up', () => sumOf(parts('0.05', 'EUR', [3, 7])) === 'EUR 0.05');
  check('100 JPY in three adds up in whole yen', () => { const p = parts('100', 'JPY', [1, 1, 1]); return sumOf(p) === 'JPY 100' && p.every(part => /^JPY \d+$/.test(show(part))); });
  check('a zero weight gets nothing and order is kept', () => { const p = parts('10.00', 'EUR', [0, 1, 3]); return p.map(show).join() === 'EUR 0.00,EUR 2.50,EUR 7.50'; });
  check('awkward weights still add up', () => [[1, 2, 3, 5, 8, 13], [7, 11, 13], [0.2, 0.3, 0.5]].every(w => sumOf(parts('1234.57', 'EUR', w)) === 'EUR 1234.57'));
  check('tax rounds half to even: 2.5 cents becomes 2, 3.5 becomes 4', () => show(tax.taxOn(mk('0.10', 'EUR'), 0.25)) === 'EUR 0.02' && show(tax.taxOn(mk('0.14', 'EUR'), 0.25)) === 'EUR 0.04');
  check('tax is per line, then summed', () => { const lines = [{ price: mk('0.10', 'EUR') }, { price: mk('0.10', 'EUR') }, { price: mk('0.10', 'EUR') }]; return show(inv.totalTax(lines, 0.25)) === 'EUR 0.06'; });
  check('tax in JPY rounds to whole yen', () => show(tax.taxOn(mk('105', 'JPY'), 0.1)) === 'JPY 10');
  check('the existing caller still prints EUR 12.50', () => rep.summary({ lines: [{ price: mk('10.00', 'EUR') }, { price: mk('2.50', 'EUR') }] }) === 'EUR 12.50');
}
let passed = 0;
for (const [name, run] of checks) { let ok = false; try { ok = run() === true; } catch (error) { notes.push(`${name}: ${String(error.message).slice(0, 120)}`); } if (ok) passed++; else notes.push(`failed: ${name}`); }
console.log(JSON.stringify({ score: checks.length ? passed / checks.length : 0, notes: notes.slice(0, 12) }));
