// Hidden check: never shown to the agents. Prints {"score": 0..1, "notes": [...]}.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const tree = process.argv[2];
const notes = [];
let passed = 0;
const cases = [['Hello World', 'hello-world'], ['  Hello   World  ', 'hello-world'], ['a\tb\nc', 'a-b-c'], ['single', 'single']];
try {
  const { slug } = await import(pathToFileURL(path.join(tree, 'slug.js')).href);
  for (const [input, expected] of cases) {
    const actual = slug(input);
    if (actual === expected) passed++;
    else notes.push(`slug(${JSON.stringify(input)}) gave ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
} catch (error) { notes.push(`slug.js does not load: ${error.message}`); }
console.log(JSON.stringify({ score: passed / cases.length, notes }));
