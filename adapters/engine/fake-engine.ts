import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The process the fake adapter starts. FAKE_SCENARIO is a comma-separated list: ok (default), limit, crash, hang, silent (no summary),
// resume-missing (a resumed session is not found, before any output), write:<path> (an edit step that creates that file),
// shell:<path> (a run step that appends to that file), leak:<text> (the text appears in a step, its output and the summary),
// pidfile:<path> (records the process id, for tests that check the process is gone),
// batch (the edit and the run step are named in one message and carried out afterwards, as engines do with several tool calls),
// batch-reversed (the same with the run step named first, so the shell's change shows up when no run step is left to take it),
// stray:<path> (that file is written during the edit step without any step naming it), output:<bytes> (the run step prints that much),
// screenshot (the browser tool leaves an image in the turn directory).
const scenarios = (process.env.FAKE_SCENARIO ?? 'ok').split(',');
const has = (name: string) => scenarios.includes(name);
const scenarioValue = (name: string) => scenarios.find(item => item.startsWith(`${name}:`))?.slice(name.length + 1);
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Steps are separated in time as a real engine's are, so the worker sees one before the next begins.
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
// The smallest valid PNG: one transparent pixel.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const resumed = flag('--resume');
if (resumed && has('resume-missing')) { process.stderr.write(`Session not found: ${resumed}\n`); process.exit(2); }
const pidfile = scenarioValue('pidfile');
if (pidfile) writeFileSync(pidfile, String(process.pid));
emit({ type: 'session', session: resumed ?? flag('--session') ?? 'fake-session-1' });
emit({ type: 'step', kind: 'think', title: `Planning the ${process.argv[2] ?? 'work'} turn`, ...(resumed ? { body: `Resumed ${resumed}` } : {}) });
if (has('hang')) setInterval(() => {}, 1000);
else if (has('limit')) { emit({ type: 'limit' }); process.exit(1); }
else if (has('crash')) process.exit(3);
else {
  const file = scenarioValue('write'), shell = scenarioValue('shell'), leak = scenarioValue('leak'), stray = scenarioValue('stray'), size = Number(scenarioValue('output') ?? 0), turnDir = flag('--turn-dir');
  const write = (target: string, text: string) => { if (target.includes('/')) mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true }); writeFileSync(target, text); };
  const output = size > 0 ? 'line of test output\n'.repeat(Math.ceil(size / 20)).slice(0, size) : `12 passed${leak ? `\nusing ${leak}` : ''}`;
  const edit = () => emit({ type: 'step', kind: 'edit', title: `Edit ${file ?? 'src/checkout.ts'}`, detail: '+4 -1', ...(file ? { target: file } : {}) });
  const run = () => emit({ type: 'step', kind: 'run', title: `npm test${leak ? ` --token=${leak}` : ''}`, detail: '12 passed', body: output });
  const doEdit = () => { if (file) write(file, `changed${leak ? ` ${leak}` : ''}\n`); if (stray) write(stray, 'nobody named this file\n'); };
  const doRun = () => { if (shell) appendFileSync(shell, 'from the shell\n'); };
  emit({ type: 'step', kind: 'read', title: 'Read src/checkout.ts', detail: 'lines 1-80' });
  await pause();
  if (has('batch')) { edit(); run(); await pause(); doEdit(); doRun(); }
  else if (has('batch-reversed')) { run(); edit(); await pause(); doRun(); doEdit(); }
  else { edit(); doEdit(); await pause(); run(); doRun(); }
  if (has('screenshot') && turnDir) { mkdirSync(path.join(turnDir, 'browser'), { recursive: true }); writeFileSync(path.join(turnDir, 'browser', 'checkout-page.png'), Buffer.from(PIXEL, 'base64')); }
  await pause();
  emit({ type: 'result', tokensIn: Number(scenarioValue('tokens') ?? 1200), tokensOut: 300, costUsd: 0.02, ...(has('silent') ? {} : { summary: `Implemented and tested.${leak ? ` ${leak}` : ''}` }) });
}
