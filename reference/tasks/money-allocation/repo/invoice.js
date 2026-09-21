import { add, allocate, money } from './money.js';
import { taxOn } from './tax.js';

export function total(lines) {
  return lines.reduce((sum, line) => add(sum, line.price), money(0));
}

export function totalTax(lines, rate) {
  return lines.reduce((sum, line) => add(sum, taxOn(line.price, rate)), money(0));
}

export function splitByShare(invoice, shares) {
  return allocate(total(invoice.lines), shares);
}
