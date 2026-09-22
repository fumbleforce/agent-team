// Amounts are plain numbers in EUR.
export function money(amount) {
  return { amount, currency: 'EUR' };
}

export function add(a, b) {
  return money(a.amount + b.amount);
}

export function allocate(total, weights) {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  return weights.map(weight => money(Math.round((total.amount * weight / sum) * 100) / 100));
}
