import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

// The process the fake adapter starts. FAKE_SCENARIO is a comma-separated list: ok (default), limit, crash, hang, silent (no summary),
// resume-missing (a resumed session is not found, before any output), write:<path> (an edit step that creates that file),
// shell:<path> (a run step that appends to that file), leak:<text> (the text appears in a step, its output and the summary),
// pidfile:<path> (records the process id, for tests that check the process is gone).
const scenarios = (process.env.FAKE_SCENARIO ?? 'ok').split(',');
const has = (name: string) => scenarios.includes(name);
const valueOf = (name: string) => scenarios.find(item => item.startsWith(`${name}:`))?.slice(name.length + 1);
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Steps are separated in time as a real engine's are, so the worker sees one before the next begins.
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

const resumed = flag('--resume');
if (resumed && has('resume-missing')) { process.stderr.write(`Session not found: ${resumed}\n`); process.exit(2); }
const pidfile = valueOf('pidfile');
if (pidfile) writeFileSync(pidfile, String(process.pid));
emit({ type: 'session', session: resumed ?? flag('--session') ?? 'fake-session-1' });
emit({ type: 'step', kind: 'think', title: `Planning the ${process.argv[2] ?? 'work'} turn`, ...(resumed ? { body: `Resumed ${resumed}` } : {}) });
if (has('hang')) setInterval(() => {}, 1000);
else if (has('limit')) { emit({ type: 'limit' }); process.exit(1); }
else if (has('crash')) process.exit(3);
else {
  const file = valueOf('write'), shell = valueOf('shell'), leak = valueOf('leak');
  emit({ type: 'step', kind: 'read', title: 'Read src/checkout.ts', detail: 'lines 1-80' });
  await pause();
  emit({ type: 'step', kind: 'edit', title: `Edit ${file ?? 'src/checkout.ts'}`, detail: '+4 -1', ...(file ? { target: file } : {}) });
  if (file) { if (file.includes('/')) mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true }); writeFileSync(file, `changed${leak ? ` ${leak}` : ''}\n`); }
  await pause();
  emit({ type: 'step', kind: 'run', title: `npm test${leak ? ` --token=${leak}` : ''}`, detail: '12 passed', body: `12 passed${leak ? `\nusing ${leak}` : ''}` });
  if (shell) appendFileSync(shell, 'from the shell\n');
  await pause();
  emit({ type: 'result', tokensIn: Number(valueOf('tokens') ?? 1200), tokensOut: 300, costUsd: 0.02, ...(has('silent') ? {} : { summary: `Implemented and tested.${leak ? ` ${leak}` : ''}` }) });
}
