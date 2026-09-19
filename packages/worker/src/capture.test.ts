import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureArgs, capturePage, captureUrl, findBrowser, type CaptureExec } from './capture.ts';

test('the command line sizes the window for the viewport and ends with the address', () => {
  const args = captureArgs({ url: 'https://staging.example.com/cart?x=1', viewport: 'mobile', outFile: '/tmp/out.png' });
  assert.deepEqual(args.slice(0, 3), ['--headless=new', '--disable-gpu', '--hide-scrollbars']);
  assert.ok(args.includes('--window-size=390,844'));
  assert.ok(args.includes('--screenshot=/tmp/out.png'));
  assert.equal(args.at(-1), 'https://staging.example.com/cart?x=1');
  assert.ok(captureArgs({ url: 'http://127.0.0.1:4000', viewport: 'desktop', outFile: 'o.png' }).includes('--window-size=1440,900'));
  assert.ok(captureArgs({ url: 'http://127.0.0.1:4000', viewport: 'tablet', outFile: 'o.png' }).includes('--window-size=820,1180'));
});

test('anything but http and https is refused before a browser is looked for', async () => {
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hi', '--remote-debugging-port=9222', 'not a url']) {
    assert.throws(() => captureUrl(url), /http|URL/, url);
    await assert.rejects(capturePage({ url, viewport: 'desktop', outFile: 'never.png', browser: 'browser', exec: async () => { throw new Error('must not run'); } }), /http|URL/);
  }
});

test('the browser comes from AGENT_TEAM_BROWSER, else the usual install places; none is a clear failure', async () => {
  const exists = (file: string) => file === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' || file === 'D:\\tools\\browser.exe';
  assert.equal(findBrowser({ env: { AGENT_TEAM_BROWSER: 'D:\\tools\\browser.exe' }, platform: 'win32', exists }), 'D:\\tools\\browser.exe');
  assert.equal(findBrowser({ env: { AGENT_TEAM_BROWSER: 'D:\\missing.exe' }, platform: 'win32', exists }), null);
  assert.equal(findBrowser({ env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, platform: 'win32', exists }), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(findBrowser({ env: { PATH: '' }, platform: 'linux', exists: () => false }), null);
  await assert.rejects(capturePage({ url: 'https://example.com', viewport: 'desktop', outFile: 'never.png', browser: null }), /No browser found/);
});

test('a run is judged by its exit, its time and the file it wrote', async () => {
  const outFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-capture-')), 'out.png');
  const seen: string[][] = [];
  const ok: CaptureExec = async (bin, args, options) => { seen.push([bin, ...args]); assert.equal(options.timeoutMs, 30_000); writeFileSync(outFile, 'png'); return { code: 0, timedOut: false, stderr: '' }; };
  const captured = await capturePage({ url: 'https://example.com', viewport: 'desktop', outFile, browser: '/usr/bin/browser', exec: ok });
  assert.equal(captured.file, outFile);
  assert.deepEqual([seen[0]![0], seen[0]!.at(-1)], ['/usr/bin/browser', 'https://example.com/']);
  await assert.rejects(capturePage({ url: 'https://example.com', viewport: 'desktop', outFile, browser: 'b', exec: async () => ({ code: null, timedOut: true, stderr: '' }) }), /30 s/);
  await assert.rejects(capturePage({ url: 'https://example.com', viewport: 'desktop', outFile, browser: 'b', exec: async () => ({ code: 1, timedOut: false, stderr: 'a\ncannot open display' }) }), /exited with 1: cannot open display/);
  await assert.rejects(capturePage({ url: 'https://example.com', viewport: 'desktop', outFile: outFile + '.missing', browser: 'b', exec: async () => ({ code: 0, timedOut: false, stderr: '' }) }), /without writing/);
});
