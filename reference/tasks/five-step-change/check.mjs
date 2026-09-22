import { pathToFileURL } from 'node:url';
import path from 'node:path';
const tree = process.argv[2];
const notes = [];
const checks = [];
const check = (name, run) => checks.push([name, run]);
const throws = (run, kind) => { try { run(); return false; } catch (error) { return error instanceof kind; } };
let module = null;
try { module = await import(pathToFileURL(path.join(tree, 'inventory.js')).href); } catch (error) { notes.push(`inventory.js does not load: ${error.message}`); }
if (module) {
  const make = () => module.createInventory();
  check('add and count', () => { const i = make(); i.add('a', 2); i.add('a', 3); return i.count('a') === 5 && i.count('nope') === 0; });
  check('remove takes stock', () => { const i = make(); i.add('a', 5); i.remove('a', 2); return i.count('a') === 3; });
  check('remove refuses what is not there and changes nothing', () => { const i = make(); i.add('a', 1); return throws(() => i.remove('a', 2), RangeError) && i.count('a') === 1; });
  check('reserved stock cannot be removed', () => { const i = make(); i.add('a', 3); i.reserve('a', 2); return i.available('a') === 1 && throws(() => i.remove('a', 2), RangeError); });
  check('reserved stock cannot be reserved again', () => { const i = make(); i.add('a', 3); i.reserve('a', 2); return throws(() => i.reserve('a', 2), RangeError); });
  check('release gives it back', () => { const i = make(); i.add('a', 3); i.reserve('a', 2); i.release('a', 2); return i.available('a') === 3; });
  check('round trip keeps counts and reservations', () => { const i = make(); i.add('a', 3); i.reserve('a', 1); const restore = module.fromJSON ?? module.createInventory.fromJSON; const j = restore(JSON.parse(JSON.stringify(i.toJSON()))); return j.count('a') === 3 && j.available('a') === 2; });
  check('quantities must be positive integers', () => { const i = make(); return throws(() => i.add('a', 0), TypeError) && throws(() => i.add('a', 1.5), TypeError) && throws(() => i.add('a', '2'), TypeError) && throws(() => i.remove('a', -1), TypeError); });
}
let passed = 0;
for (const [name, run] of checks) { let ok = false; try { ok = run() === true; } catch (error) { notes.push(`${name}: ${error.message}`); } if (ok) passed++; else notes.push(`failed: ${name}`); }
console.log(JSON.stringify({ score: checks.length ? passed / checks.length : 0, notes }));
