import type { HarnessHealthView } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { BarRow, MatrixTable, NoteCard } from '../../patterns';
import { Card, SectionLabel, StatTile, Text } from '../../ui';

interface Run { id: string; suite: string; status: string; passed: number; total: number; failed: number }
interface Matrix { suites: string[]; branches: { branch: string; lastRunAt: number; runs: Run[] }[]; failing: { run_id: string; name: string; message: string | null; branch: string; suite: string }[] }

const ago = (ms: number) => { const minutes = Math.round((Date.now() - ms) / 60_000); return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`; };

const wall = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
const many = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
// One change to the harness in a sentence: how the number of cases moved, and what went into or came out of quarantine.
const changeWords = (change: HarnessHealthView['changes'][number]) => [
  change.totalAfter > change.totalBefore ? `${many(change.totalAfter - change.totalBefore, 'case')} added, now ${change.totalAfter}` : change.totalAfter < change.totalBefore ? `${many(change.totalBefore - change.totalAfter, 'case')} removed, now ${change.totalAfter}` : '',
  change.quarantinedAdded.length ? `quarantined as flaky: ${change.quarantinedAdded.join(', ')}` : '',
  change.quarantinedRemoved.length ? `back from quarantine: ${change.quarantinedRemoved.join(', ')}` : '',
].filter(Boolean).join(' · ');

// How the checks themselves are doing on the branch changes are delivered to: how many there are, which are switched off as flaky,
// how long each suite takes, and what changed between runs.
function HarnessHealth({ health, code }: { health: HarnessHealthView; code: boolean }) {
  const slowest = Math.max(1, ...health.suites.map(suite => suite.durationMs));
  return (
    <Card className="flex flex-col gap-2.5">
      <SectionLabel>Harness health</SectionLabel>
      {health.suites.length === 0 ? <Text size="small" tone="muted">{code ? `No runs on ${health.branch} yet. Health is read from the branch changes are delivered to.` : 'No checks on the current version yet.'}</Text> : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile label={code ? `Cases on ${health.branch}` : 'Checks in total'} value={health.totalCases} note={many(health.suites.length, 'suite')} />
            <StatTile label="Quarantined as flaky" value={health.quarantinedCases.length} note="Skipped on purpose until someone fixes them" />
            <StatTile label="Time for a full run" value={wall(health.suites.reduce((sum, suite) => sum + suite.durationMs, 0))} note="Every suite, one after the other" />
          </div>
          <div className="flex flex-col gap-1.5">
            {health.suites.map(suite => <BarRow key={suite.suite} label={suite.suite} value={wall(suite.durationMs)} note={many(suite.total, 'case')} share={suite.durationMs / slowest} />)}
          </div>
          {health.quarantinedCases.map(item => <NoteCard key={`${item.suite}${item.name}`} meta={`${item.suite} · quarantined`}>{item.name}</NoteCard>)}
          <Text size="small" weight="semibold">What changed</Text>
          {health.changes.map(change => <NoteCard key={`${change.at}${change.suite}`} meta={`${change.suite} · ${ago(change.at)} ago`}>{changeWords(change)}</NoteCard>)}
          {health.changes.length === 0 && <Text size="small" tone="muted">Nothing has changed between runs: the same cases, none newly quarantined.</Text>}
        </>
      )}
    </Card>
  );
}

// `code` says whether the project is a repository: its runs are per branch and come from pipelines; elsewhere they are per version of the work.
export function ChecksTab({ slug, code = true }: { slug: string; code?: boolean }) {
  const matrix = useResource<Matrix>(`/api/projects/${slug}/checks`);
  const health = useResource<HarnessHealthView>(`/api/projects/${slug}/checks/health`);
  useStream(event => event.type.startsWith('check.'), () => { matrix.reload(); health.reload(); });
  const data = matrix.data;
  if (!data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;
  if (data.branches.length === 0) return <div className="p-5"><Text tone="muted">{code ? 'No runs reported yet. Agents report them with test.report; a pipeline can upload JUnit XML.' : 'No checks reported yet. The team reports them as it reviews its work.'}</Text></div>;
  return (
    <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-5 pt-4 pb-5">
      <MatrixTable rowLabel={code ? 'Branch' : 'Version'}
        columns={data.suites}
        rows={data.branches.map(row => ({ label: row.branch, aside: ago(row.lastRunAt), cells: data.suites.map(suite => { const run = row.runs.find(item => item.suite === suite); return run ? { tone: run.status === 'failed' ? 'stop' as const : run.status === 'passed' ? 'working' as const : 'off' as const, text: `${run.passed} / ${run.total}` } : null; }) }))}
      />
      <Card className="flex flex-col gap-2.5">
        <SectionLabel>Failing now</SectionLabel>
        {data.failing.map(item => <NoteCard key={`${item.run_id}${item.name}`} meta={`${item.branch} · ${item.suite}`}>{item.name}{item.message ? ` — ${item.message}` : ''}</NoteCard>)}
        {data.failing.length === 0 && <Text size="small" tone="working">Everything passing.</Text>}
      </Card>
      {health.data && <HarnessHealth health={health.data} code={code} />}
    </div>
  );
}
