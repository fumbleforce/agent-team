import { total } from './invoice.js';

// Existing caller: prints "EUR 12.50".
export function summary(invoice) {
  const sum = total(invoice.lines);
  return `${sum.currency} ${sum.amount.toFixed(2)}`;
}
