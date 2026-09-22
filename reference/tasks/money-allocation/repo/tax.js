import { money } from './money.js';

export function taxOn(line, rate) {
  return money(Math.round(line.amount * rate * 100) / 100);
}
