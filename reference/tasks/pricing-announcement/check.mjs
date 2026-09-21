import { readFileSync } from 'node:fs';
const outcome = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const text = String(outcome.document ?? ''), notes = [];
const must = [
  ['the new price, €35', /€\s?35|35\s?€|EUR\s?35/],
  ['the old price, €29', /€\s?29|29\s?€|EUR\s?29/],
  ['that existing customers move on 1 September 2027', /(1(st)?\s+September|September\s+1(st)?),?\s+2027/i],
  ['what happens to annual plans', /annual|yearly/i],
  ['that they are tied to renewal', /renew/i],
  ['the sentence legal requires, exactly', /You can cancel at any time before the change takes effect\./],
  ['why', /offline|audit log|SSO|since 2024/i],
];
const mustNot = [
  ['the rumoured €39', /€\s?39|39\s?€/],
  ['the rumoured February date', /February/i],
  ['1 March as the date for existing customers, which is for new ones', /(?<!new customers[^.]{0,60})(your|existing)[^.]{0,80}1(st)?\s+March/i],
  ['a promise that prices will not change again', /(will not|won't|never)[^.]{0,40}(increase|change|raise)[^.]{0,20}again|no further (increase|change)/i],
];
let score = 0;
for (const [name, pattern] of must) { if (pattern.test(text)) score += 1; else notes.push(`missing: ${name}`); }
let wrong = 0;
for (const [name, pattern] of mustNot) if (pattern.test(text)) { wrong++; notes.push(`says ${name}`); }
const words = text.trim().split(/\s+/).filter(Boolean).length;
if (words === 0) notes.push('nothing was handed in');
if (words > 250) notes.push(`${words} words, over the 250 allowed`);
// A wrong fact in a customer email costs more than a missing one.
const result = words === 0 ? 0 : Math.max(0, score / must.length - 0.25 * wrong - (words > 250 ? 0.15 : 0));
console.log(JSON.stringify({ score: Number(result.toFixed(3)), notes }));
