import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit } from './junit.ts';

const XML = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="checkout" tests="4" time="1.5">
    <testcase classname="pay-button.spec" name="re-enables after 8s offline" time="0.8">
      <failure message="Expected button enabled, got disabled at 8.4s">at pay.ts:12 &lt;anonymous&gt;</failure>
    </testcase>
    <testcase classname="pay-button.spec" name="sends key once" time="0.2"/>
    <testcase classname="webhooks.spec" name="v1 behind flag" time="0.4"><error><![CDATA[Flag WEBHOOKS_V1 unset & missing]]></error></testcase>
    <testcase classname="webhooks.spec" name="signature" time="0.1"><skipped/></testcase>
  </testsuite>
</testsuites>`;

test('counts every case and keeps only the failing ones with their message', () => {
  const report = parseJUnit(XML);
  assert.deepEqual([report.total, report.passed, report.failed, report.skipped, report.durationMs], [4, 1, 2, 1, 1500]);
  assert.deepEqual(report.failing.map(item => item.name), ['pay-button.spec › re-enables after 8s offline', 'webhooks.spec › v1 behind flag']);
  assert.equal(report.failing[0]!.message, 'Expected button enabled, got disabled at 8.4s');
  assert.equal(report.failing[1]!.message, 'Flag WEBHOOKS_V1 unset & missing');
});

test('an empty suite is a report; anything else is refused', () => {
  assert.equal(parseJUnit('<testsuite tests="0"></testsuite>').total, 0);
  assert.throws(() => parseJUnit('{"not":"xml"}'), /Not a JUnit/);
});
