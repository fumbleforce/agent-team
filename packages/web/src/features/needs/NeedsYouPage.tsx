import { useState } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type Me, type ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { EmptyState, SettingsBody } from '../../patterns';
import { Button, Card, Chip, Field, LinkButton, Text, Textarea, type ChipTone } from '../../ui';
import { OrgShell } from '../org/OrgShell';

interface Item { kind: 'decision' | 'quarantine' | 'delivery' | 'proposal' | 'blocked'; id: string; projectId: string; title: string; detail: string; since: number; taskKey: string | null; href: string | null; canDecide: boolean; raw?: string | null; mergeRefused?: boolean; about?: { taskHref: string | null; taskTitle: string | null; who: string | null; doing: string | null; lastReport: string | null; branch: string | null; changeUrl: string | null } }
const LABEL: Record<Item['kind'], { chip: string; tone: ChipTone }> = { decision: { chip: 'Your call', tone: 'review' }, quarantine: { chip: 'Cut off mid-work', tone: 'stop' }, delivery: { chip: 'Cut off mid-merge', tone: 'stop' }, proposal: { chip: 'Proposal', tone: 'review' }, blocked: { chip: 'Blocked', tone: 'attention' } };
const ago = (since: number) => { const minutes = Math.max(1, Math.round((Date.now() - since) / 60_000)); return minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`; };

// Everything only a person can settle, oldest first. Each kind explains what happened and offers the choices that exist for it.
export function NeedsYouPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const view = useResource<{ items: Item[] }>('/api/needs-you');
  useStream(event => /^(decision|quarantine|delivery|proposal|task|turn)\./.test(event.type), view.reload);
  const names = new Map(projects.flatMap(project => [project, ...project.subprojects]).map(project => [project.id, project.name]));
  return (
    <OrgShell me={me} projects={projects} title="Needs you" active={null}>
      <SettingsBody><div className="flex max-w-3xl flex-col gap-3">
        {view.data?.items.length === 0 && <EmptyState title="Nothing needs you" note="What needs a person shows up here." />}
        {view.data?.items.map(item => <NeedCard key={`${item.kind}:${item.id}`} item={item} project={names.get(item.projectId) ?? ''} onDone={view.reload} />)}
      </div></SettingsBody>
    </OrgShell>
  );
}

function NeedCard({ item, project, onDone }: { item: Item; project: string; onDone(): void }) {
  const [text, setText] = useState(''), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown) => { setBusy(true); setError(null); try { await api(path, body); onDone(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That did not work; try again.'); } finally { setBusy(false); } };
  const needsText = item.kind === 'decision' || item.kind === 'quarantine';
  return (
    <Card tone={item.kind === 'blocked' ? 'raised' : 'decision'} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2"><Chip tone={LABEL[item.kind].tone}>{LABEL[item.kind].chip}</Chip><Text weight="semibold" truncate>{item.title}</Text><Text size="caption" tone="muted" className="ml-auto whitespace-nowrap">{project} · {ago(item.since)}</Text></div>
      <Text size="small" tone="soft">{item.detail}</Text>
      {item.raw && <Text size="caption" tone="faint" mono>{item.raw}</Text>}
      {!item.raw && item.about?.lastReport && <Text size="small" tone="muted">Last report: {item.about.lastReport}</Text>}
      {item.about && (item.about.taskHref || item.about.changeUrl || item.about.branch) && <div className="flex flex-wrap items-center gap-2">
        {item.about.taskHref && <LinkButton size="sm" href={item.about.taskHref}>Open the task</LinkButton>}
        {item.about.changeUrl && <LinkButton size="sm" href={item.about.changeUrl} target="_blank" rel="noreferrer noopener">Open the change ↗</LinkButton>}
        {item.about.branch && <Text size="caption" tone="muted" mono>{item.about.branch}</Text>}
      </div>}
      {!item.canDecide ? <Text size="caption" tone="muted">Someone who may decide for this project has to settle this.</Text> : (
        <>
          {needsText && <Field label={item.kind === 'decision' ? 'Your decision, in your own words' : 'A note, if you want to leave one'} error={error ?? undefined}><Textarea rows={2} value={text} onChange={event => setText(event.target.value)} placeholder={item.kind === 'decision' ? 'Go with option B, but keep the old endpoint for one release.' : ''} /></Field>}
          {!needsText && error && <Text size="small" tone="stop">{error}</Text>}
          <div className="flex flex-wrap gap-2">
            {item.kind === 'blocked' && !item.mergeRefused && <Button variant="primary" disabled={busy} onClick={() => act(`/api/tasks/${item.id}/carry-on`, {})}>Carry on</Button>}
            {item.kind === 'blocked' && item.mergeRefused && <Button variant="primary" disabled={busy} onClick={() => act(`/api/tasks/${item.id}/merge-again`, {})}>Merge again</Button>}
            {item.kind === 'decision' && <Button variant="primary" disabled={busy || !text.trim()} onClick={() => act(`/api/decisions/${item.id}/resolve`, { answer: text })}>Record the decision</Button>}
            {item.kind === 'quarantine' && <><Button variant="primary" disabled={busy} onClick={() => act(`/api/quarantines/${item.id}/release`, { resolution: 'continue', note: text })}>Continue from where it is</Button><Button disabled={busy} onClick={() => act(`/api/quarantines/${item.id}/release`, { resolution: 'stop', note: text })}>Stop this task</Button></>}
            {item.kind === 'delivery' && <><Button variant="primary" disabled={busy} onClick={() => act(`/api/deliveries/${item.id}/reconcile`, { merged: true })}>It was merged</Button><Button disabled={busy} onClick={() => act(`/api/deliveries/${item.id}/reconcile`, { merged: false })}>It was not merged: try again</Button></>}
            {item.href && <Link href={item.href}><Text size="small" tone="accent">{item.kind === 'proposal' ? 'Read and decide →' : 'Open the discussion →'}</Text></Link>}
          </div>
        </>
      )}
    </Card>
  );
}
