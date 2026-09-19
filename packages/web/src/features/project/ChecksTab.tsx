import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { MatrixTable, NoteCard } from '../../patterns';
import { Card, SectionLabel, Text } from '../../ui';

interface Run { id: string; suite: string; status: string; passed: number; total: number; failed: number }
interface Matrix { suites: string[]; branches: { branch: string; lastRunAt: number; runs: Run[] }[]; failing: { run_id: string; name: string; message: string | null; branch: string; suite: string }[] }

const ago = (ms: number) => { const minutes = Math.round((Date.now() - ms) / 60_000); return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`; };

// `code` says whether the project is a repository: its runs are per branch and come from pipelines; elsewhere they are per version of the work.
export function ChecksTab({ slug, code = true }: { slug: string; code?: boolean }) {
  const matrix = useResource<Matrix>(`/api/projects/${slug}/checks`);
  useStream(event => event.type.startsWith('check.'), matrix.reload);
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
    </div>
  );
}
