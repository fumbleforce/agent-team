import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fake } from '../../../adapters/engine/fake.ts';
import { executeTurn, failureSummary } from './execute.ts';

const run = (scenario: string, timeoutMs = 5000) => executeTurn({
  adapter: fake, spec: { turnId: 't1', kind: 'work', cwd: os.tmpdir(), prompt: 'go', systemPrompt: '', model: null, sessionId: null, toolProfile: 'write', platform: null },
  turnDir: mkdtempSync(path.join(os.tmpdir(), 'agent-team-execute-')), env: { ...process.env, FAKE_SCENARIO: scenario }, timeoutMs, signal: new AbortController().signal, onSteps: () => {},
});

test('a crashed engine names its cause and the last of its stderr in the summary', async () => {
  const result = await run('crash');
  assert.equal(result.state, 'failed');
  assert.equal(result.stopReason, 'crashed');
  assert.match(result.summary ?? '', /The engine stopped without finishing\. \(crashed, exit 3\)/);
  assert.match(result.summary ?? '', /MCP server "platform" failed to start/);
});

test('a usage limit is still deferred, not failed, and carries no failure text', async () => {
  const result = await run('limit');
  assert.equal(result.state, 'deferred');
  assert.equal(result.stopReason, 'rate-limited');
  assert.equal(result.summary, null);
});

test('a turn that runs out of time says so', async () => {
  const result = await run('hang', 300);
  assert.equal(result.state, 'timed_out');
  assert.match(result.summary ?? '', /ran out of time\. \(timeout, signal SIGTERM\)/);
});

test('the failure summary is bounded and keeps the engine\'s own summary on top', () => {
  const noisy = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
  const text = failureSummary('auth', { code: 1, signal: null }, 'Half done.', noisy);
  assert.ok(text.startsWith('Half done.\n\nThe engine is not logged in on this worker. (auth, exit 1)'));
  assert.ok(!text.includes('line 27\n') && text.includes('line 28\n'), 'only the last lines are kept');
  assert.equal(failureSummary('crashed', { code: null, signal: 'SIGKILL' }, null, ''), 'The engine stopped without finishing. (crashed, signal SIGKILL)');
});

test('the whole summary fits what the coordinator takes, whatever the engine wrote: the cause and the tail survive, the engine\'s text is cut', () => {
  const text = failureSummary('crashed', { code: 3, signal: null }, 'r'.repeat(2000), 'e'.repeat(8192));
  assert.ok(text.length <= 2000, `${text.length} chars`);
  assert.ok(text.startsWith('rrrr'));
  assert.match(text, /The engine stopped without finishing\. \(crashed, exit 3\)/);
  assert.ok(text.endsWith('e'.repeat(1500) + '\n```'));
});
