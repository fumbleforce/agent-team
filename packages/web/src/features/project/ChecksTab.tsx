import { useState } from 'react';
import { uploadCheckResults, type HarnessHealthView } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { BarRow, EmptyState, EntityLink, MatrixTable, NoteCard, Notice, Steps } from '../../patterns';
import { Button, Card, Field, Input, LinkButton, SectionLabel, StatTile, Text } from '../../ui';

interface Run { id: string; suite: string; status: string; passed: number; total: number; failed: number }
interface Matrix { suites: string[]; branches: { branch: string; lastRunAt: number; runs: Run[] }[]; failing: { run_id: string; name: string; message: string | null; branch: string; suite: string; owner: { id: string; name: string } | null; taskKey: string | null; issue: { number: number; title: string } | null }[] }

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

// Bringing results in by hand: pick the file a test tool saved, say what it covers and where it ran.
function UploadResults({ slug, branch, onDone }: { slug: string; branch: string; onDone(): void }) {
  const [suite, setSuite] = useState('');
  const [where, setWhere] = useState(branch);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    if (!file) return;
    setBusy(true); setResult(null);
    try { await uploadCheckResults(slug, suite.trim(), where.trim() || branch, file); setResult({ ok: true, text: 'The results are in.' }); setFile(null); onDone(); }
    catch (error) { setResult({ ok: false, text: `${(error as Error).message}. The file has to be in the “JUnit XML” format, which most test tools can save.` }); }
    finally { setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="What do these results cover?">
          <Input value={suite} onChange={event => setSuite(event.target.value)} placeholder="Unit tests" maxLength={60} required />
        </Field>
        <Field label="Which branch were they run on?" help={`Leave it as “${branch}” for the version everyone shares.`}>
          <Input value={where} onChange={event => setWhere(event.target.value)} maxLength={120} />
        </Field>
      </div>
      <Field label="Results file" help="JUnit XML.">
        <Input type="file" accept=".xml,text/xml,application/xml" onChange={event => setFile(event.target.files?.[0] ?? null)} />
      </Field>
      {result && <Notice tone={result.ok ? 'working' : 'stop'} title={result.ok ? 'Uploaded' : 'The file could not be read'}>{result.text}</Notice>}
      <div className="flex"><Button type="submit" variant="primary" disabled={busy || !file || !suite.trim()}>{busy ? 'Uploading…' : 'Upload results'}</Button></div>
    </form>
  );
}

// What an empty Tests page says: what will be here, and the three ways results arrive.
function NoResultsYet({ slug, branch, onDone }: { slug: string; branch: string; onDone(): void }) {
  return (
    <div className="flex max-w-180 flex-col gap-3.5 p-5">
      <EmptyState title="No test results yet" note="Which tests pass on each branch, and who is on a failure." />
      <Card className="flex flex-col gap-3">
        <SectionLabel>How results get here</SectionLabel>
        <Steps items={[
          'Connect your code host and its test results appear here.',
          'Agents report the tests they run while they work. There is nothing to set up for that.',
          'Or upload a results file yourself, below.',
        ]} />
        <div className="flex"><LinkButton href={`/p/${slug}/integrations`}>Connect a code host</LinkButton></div>
      </Card>
      <Card className="flex flex-col gap-3">
        <SectionLabel>Upload a results file</SectionLabel>
        <UploadResults slug={slug} branch={branch} onDone={onDone} />
      </Card>
    </div>
  );
}

// `code` says whether the project is a repository: its runs are per branch and come from pipelines; elsewhere they are per version of the work.
export function ChecksTab({ slug, code = true }: { slug: string; code?: boolean }) {
  const matrix = useResource<Matrix>(`/api/projects/${slug}/checks`);
  const health = useResource<HarnessHealthView>(`/api/projects/${slug}/checks/health`);
  useStream(event => event.type.startsWith('check.'), () => { matrix.reload(); health.reload(); });
  const data = matrix.data;
  if (!data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;
  const refresh = () => { matrix.reload(); health.reload(); };
  if (data.branches.length === 0) return code ? <NoResultsYet slug={slug} branch={health.data?.branch ?? 'main'} onDone={refresh} /> : <div className="max-w-180 p-5"><EmptyState title="No checks yet" note="What the team checked when it reviewed its work." /></div>;
  return (
    <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-5 pt-4 pb-5">
      <MatrixTable rowLabel={code ? 'Branch' : 'Version'}
        columns={data.suites}
        rows={data.branches.map(row => ({ label: row.branch, aside: ago(row.lastRunAt), cells: data.suites.map(suite => { const run = row.runs.find(item => item.suite === suite); return run ? { tone: run.status === 'failed' ? 'stop' as const : run.status === 'passed' ? 'working' as const : 'off' as const, text: `${run.passed} / ${run.total}` } : null; }) }))}
      />
      <Card className="flex flex-col gap-2.5">
        <SectionLabel>Failing now</SectionLabel>
        {data.failing.map(item => <NoteCard key={`${item.run_id}${item.name}`} meta={<>{item.suite} on {item.branch} · {item.owner ? `${item.owner.name} is on it${item.taskKey ? ` (${item.taskKey})` : ''}` : 'nobody is on it yet'}{item.issue && <> · <EntityLink kind="issue" href={`/p/${slug}/issues/${item.issue.number}`} code={String(item.issue.number)}>{item.issue.title}</EntityLink></>}</>}>{item.name}{item.message ? ` — ${item.message}` : ''}</NoteCard>)}
        {data.failing.length === 0 && <Text size="small" tone="working">Everything passing.</Text>}
      </Card>
      {health.data && <HarnessHealth health={health.data} code={code} />}
      {code && (
        <Card className="flex flex-col gap-3">
          <SectionLabel>Upload a results file</SectionLabel>
          <Text size="small" tone="muted">Results arrive from the code host and the agents. A file works too.</Text>
          <UploadResults slug={slug} branch={health.data?.branch ?? 'main'} onDone={refresh} />
        </Card>
      )}
    </div>
  );
}
