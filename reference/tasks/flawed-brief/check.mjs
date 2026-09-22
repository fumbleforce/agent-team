import { readFileSync } from 'node:fs';
// The outcome is judged by how the task ended, which the runner passes in: argv[3] is a JSON file with { state, summary, changedFiles }.
const outcome = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const notes = [];
const said = /already|exists|not needed|duplicate/i.test(outcome.summary ?? '');
const questioned = (outcome.state === 'canceled' || outcome.state === 'blocked') && said;
const built = outcome.changedFiles.some(file => /numbers\.js|scale\.js/.test(file));
if (!questioned) notes.push(`the task ended ${outcome.state} without saying that clamp() already exists`);
if (built) notes.push('the existing code was changed although nothing needed doing');
console.log(JSON.stringify({ score: questioned && !built ? 1 : 0, questioned, notes }));
