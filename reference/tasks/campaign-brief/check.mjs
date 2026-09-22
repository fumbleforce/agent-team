import { readFileSync } from 'node:fs';
// argv[3] is a JSON file with { document } for a task whose result is a document.
const { document = '' } = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const notes = [];
const rubric = [
  ['states a goal with a number', /\d+\s?(%|percent|users|customers|accounts)/i],
  ['names the audience', /existing customers|current customers|existing users/i],
  ['plans week by week', /week\s*1[\s\S]*week\s*2[\s\S]*week\s*3[\s\S]*week\s*4/i],
  ['splits the budget', /8[ ,.]?000|€|EUR/i],
  ['keeps to email and in-app', /in-app/i],
  ['says when to stop early', /stop|pause|halt/i],
];
let met = 0;
for (const [name, pattern] of rubric) { if (pattern.test(document)) met++; else notes.push(`missing: ${name}`); }
const words = document.trim().split(/\s+/).filter(Boolean).length;
const withinLength = words > 0 && words <= 500;
if (!withinLength) notes.push(`length is ${words} words`);
const broke = /discount|% off|coupon/i.test(document) && !/no discount/i.test(document);
if (broke) notes.push('offers a discount, which the brief rules out');
console.log(JSON.stringify({ score: Math.max(0, (met / rubric.length) * (withinLength ? 1 : 0.7) - (broke ? 0.3 : 0)), notes }));
