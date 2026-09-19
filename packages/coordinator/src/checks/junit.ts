export interface JUnitCase { name: string; status: 'passed' | 'failed' | 'skipped'; message: string | null }
export interface JUnitReport { passed: number; failed: number; skipped: number; total: number; durationMs: number; failing: JUnitCase[]; quarantined?: JUnitCase[] }

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const decode = (text: string) => text.replace(/&(lt|gt|amp|quot|apos);/g, entity => ENTITIES[entity] ?? entity).replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
const attribute = (tag: string, name: string) => { const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag); return match ? decode(match[2] ?? match[3] ?? '') : null; };

// The subset of JUnit XML every runner emits: testcase elements with optional failure, error or skipped children.
// Only failing cases are kept; the rest is counted. A skipped case whose reason says it is quarantined or flaky is kept
// too: that is how a harness marks a case it no longer trusts, and harness health counts them.
export function parseJUnit(xml: string): JUnitReport {
  if (xml.length > 20_000_000) throw new Error('JUnit report too large');
  const report: JUnitReport = { passed: 0, failed: 0, skipped: 0, total: 0, durationMs: 0, failing: [], quarantined: [] };
  const cases = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let match = cases.exec(xml); match; match = cases.exec(xml)) {
    const tag = match[1] ?? '', body = match[3] ?? '';
    const name = [attribute(tag, 'classname'), attribute(tag, 'name')].filter(Boolean).join(' › ') || '(unnamed)';
    report.total++;
    report.durationMs += Math.round(Number(attribute(tag, 'time') ?? 0) * 1000) || 0;
    const problem = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (problem) {
      report.failed++;
      const text = decode((problem[4] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
      if (report.failing.length < 200) report.failing.push({ name, status: 'failed', message: (attribute(problem[2] ?? '', 'message') ?? text).slice(0, 1000) || null });
    } else if (/<skipped\b/.test(body)) {
      report.skipped++;
      const skipped = /<skipped\b([^>]*?)(\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
      const reason = decode([attribute(skipped?.[1] ?? '', 'message'), attribute(skipped?.[1] ?? '', 'type'), skipped?.[3]].filter(Boolean).join(' ')).trim();
      if (/quarantin|flaky/i.test(reason) && report.quarantined!.length < 200) report.quarantined!.push({ name, status: 'skipped', message: reason.slice(0, 1000) || null });
    } else report.passed++;
  }
  if (report.total === 0 && !/<testsuite/.test(xml)) throw new Error('Not a JUnit report');
  return report;
}
