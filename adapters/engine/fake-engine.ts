import { mkdirSync, writeFileSync } from 'node:fs';

// The process the fake adapter starts. Scenarios: ok (default), limit, crash, hang, write:<path> (creates that file in the working directory).
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: 'session', session: 'fake-session-1' });
emit({ type: 'step', kind: 'think', title: `Planning the ${process.argv[2] ?? 'work'} turn` });
if (scenario === 'hang') setInterval(() => {}, 1000);
else if (scenario === 'limit') { emit({ type: 'limit' }); process.exit(1); }
else if (scenario === 'crash') process.exit(3);
else {
  if (scenario.startsWith('write:')) { const file = scenario.slice(6); if (file.includes('/')) mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true }); writeFileSync(file, 'changed'); }
  emit({ type: 'step', kind: 'read', title: 'Read src/checkout.ts', detail: 'lines 1-80' });
  emit({ type: 'step', kind: 'edit', title: 'Edit src/checkout.ts', detail: '+4 -1' });
  emit({ type: 'step', kind: 'run', title: 'npm test', detail: '12 passed' });
  emit({ type: 'result', tokensIn: 1200, tokensOut: 300, costUsd: 0.02, summary: 'Implemented and tested.' });
}
