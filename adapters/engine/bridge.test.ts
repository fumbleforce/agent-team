import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ENTRYPOINTS, packageRoot } from '@agent-team/protocol';

// The bridge an engine starts as its MCP server: each line on stdin is posted with the token from the file, the answers come back on stdout,
// a session the server names is kept, and a notification gets no answer.
test('the MCP bridge carries messages to the server with the token from its file, and answers come back in order', async () => {
  const seen: { auth: string | undefined; session: string | undefined; body: { id?: number; method: string } }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      seen.push({ auth: request.headers.authorization, session: request.headers['mcp-session-id'] as string | undefined, body: message });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      if (message.method === 'tools/list') { response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n\n`); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: message.method } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const tokenFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'bridge-')), 'token');
  writeFileSync(tokenFile, 'turn-secret\n');
  try {
    const child = spawn(process.execPath, [path.join(packageRoot(), ENTRYPOINTS.cli), 'mcp-bridge', url, tokenFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.end([{ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map(message => JSON.stringify(message)).join('\n'));
    await new Promise(resolve => child.on('close', resolve));
    assert.deepEqual(out.trim().split('\n').map(line => JSON.parse(line)), [{ jsonrpc: '2.0', id: 1, result: { ok: 'initialize' } }, { jsonrpc: '2.0', id: 2, result: { tools: [] } }]);
    assert.deepEqual(seen.map(item => [item.body.method, item.auth, item.session]), [['initialize', 'Bearer turn-secret', undefined], ['notifications/initialized', 'Bearer turn-secret', 's-1'], ['tools/list', 'Bearer turn-secret', 's-1']]);
  } finally { server.close(); }
});
