import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, builtinEnvironments, capabilityInstructions, capabilityServers, provisioning, validateEnvironment } from './environments.mjs';

test('environments validate against the capability catalog and launcher fields', () => {
  const environment = validateEnvironment({ id: 'ui', name: 'UI', capabilities: ['browser', 'browser'], launcher: { instanceType: 'c6i.xlarge', image: '' }, packages: ['ffmpeg'] });
  assert.deepEqual(environment, { id: 'ui', name: 'UI', description: '', capabilities: ['browser'], launcher: { instanceType: 'c6i.xlarge' }, packages: ['ffmpeg'] });
  assert.throws(() => validateEnvironment({ id: 'ui', name: 'UI', capabilities: ['gpu'] }), /capabilities must list/);
  assert.throws(() => validateEnvironment({ id: 'ui', name: 'UI', launcher: { region: 'x' } }), /not a launcher field/);
  assert.throws(() => validateEnvironment({ id: 'ui', name: 'UI', packages: ['rm -rf'] }), /package names/);
  assert.throws(() => validateEnvironment({ id: 'UI', name: 'UI' }), /lowercase/);
  assert.deepEqual(builtinEnvironments().map(item => item.id), ['standard', 'browser', 'full']);
});

test('capabilities become MCP servers, provisioning and prompt notes', () => {
  const browser = builtinEnvironments()[1];
  const servers = capabilityServers(browser, '/runs/1');
  assert.deepEqual(Object.keys(servers), ['browser']);
  assert.equal(servers.browser.type, 'stdio'); assert.equal(servers.browser.command, 'npx');
  assert.ok(servers.browser.args.includes('--headless')); assert.ok(servers.browser.args.includes('/runs/1/browser'));
  assert.match(capabilityInstructions(browser), /Worker environment "Browser":\n- A headless browser/);
  assert.equal(capabilityInstructions(builtinEnvironments()[0]), '');
  assert.deepEqual(provisioning(builtinEnvironments()[2]), { packages: ['chromium', 'fonts-liberation', 'docker.io', 'xvfb'], setup: [CAPABILITIES.browser.setup] });
  assert.deepEqual(capabilityServers(builtinEnvironments()[2], '/r'), { browser: servers.browser && { ...servers.browser, args: servers.browser.args.map(arg => arg.replace('/runs/1', '/r')) } }, 'docker and display add no server');
});
