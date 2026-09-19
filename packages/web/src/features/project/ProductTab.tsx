import { useEffect, useState, type ClipboardEvent } from 'react';
import { api } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { ListLink, PreviewFrame, SidePanel } from '../../patterns';
import { Button, Chip, Field, Input, MarkerCanvas, SectionLabel, Segmented, Text, Textarea, type Marker } from '../../ui';

interface Environment { id: string; name: string; branch: string | null; url: string; last_status: string | null; last_latency_ms: number | null }
interface Snapshot { id: string; env_id: string; viewport: Viewport; state: 'requested' | 'captured' | 'failed'; error: string | null; attachment_id: string | null }
type Viewport = 'desktop' | 'tablet' | 'mobile';
const VIEWPORTS: { value: Viewport; label: string }[] = [{ value: 'desktop', label: 'Desktop' }, { value: 'tablet', label: 'Tablet' }, { value: 'mobile', label: 'Mobile' }];
interface Raised { id: string; number: number; title: string; state: string }

async function upload(file: File): Promise<string> {
  const response = await fetch(`/api/attachments?name=${encodeURIComponent(file.name || 'snapshot.png')}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  if (!response.ok) throw new Error('Upload failed');
  return (await response.json() as { id: string }).id;
}

export function ProductTab({ slug, navigate }: { slug: string; navigate(to: string): void }) {
  const view = useResource<{ environments: Environment[]; snapshots: Snapshot[]; raised: Raised[] }>(`/api/projects/${slug}/product`);
  const [chosen, setChosen] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [pasted, setPasted] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const environments = view.data?.environments ?? [];
  const environment = environments.find(item => item.id === chosen) ?? environments[0] ?? null;

  // Newest first: the latest request says what is happening, the latest finished one is what there is to look at.
  const mine = (view.data?.snapshots ?? []).filter(item => item.env_id === environment?.id && item.viewport === viewport);
  const latest = mine[0] ?? null;
  const captured = mine.find(item => item.state === 'captured' && item.attachment_id) ?? null;
  const snapshot = pasted ?? captured?.attachment_id ?? null;
  useStream(event => event.type.startsWith('snapshot.'), view.reload);
  useEffect(() => { setMarkers([]); }, [snapshot]);

  const capture = async () => { if (environment) await api(`/api/projects/${slug}/envs/${environment.id}/capture`, { viewport }).then(() => { setError(null); setPasted(null); view.reload(); }, failure => setError((failure as Error).message)); };
  const paste = (event: ClipboardEvent) => { const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/')); if (file) void upload(file).then(id => { setPasted(id); }, failure => setError((failure as Error).message)); };
  const send = async () => {
    if (!snapshot || !text.trim()) return;
    const created = await api<{ number: number }>(`/api/projects/${slug}/issues`, { title: text.trim().split('\n')[0]!.slice(0, 120), body: text.trim(), source: 'product', attachmentId: snapshot, markers, environment: environment?.name ?? null });
    navigate(`/p/${slug}/issues/${created.number}`);
  };
  const addEnvironment = async (form: FormData) => { await api(`/api/projects/${slug}/product`, { name: form.get('name'), url: form.get('url') }).then(view.reload, failure => setError((failure as Error).message)); };

  return (
    <div className="flex min-h-0 grow" onPaste={paste}>
      <div className="flex min-w-0 grow flex-col gap-3 p-5">
        {environments.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={environment?.id ?? ''} onChange={setChosen} options={environments.map(item => ({ value: item.id, label: item.branch ? `${item.name} · ${item.branch}` : item.name }))} />
            <Segmented<Viewport> value={viewport} onChange={setViewport} options={VIEWPORTS} />
            <Button variant="primary" disabled={latest?.state === 'requested'} onClick={() => { void capture(); }}>{latest?.state === 'requested' ? 'Capturing…' : 'Capture'}</Button>
            {environment?.last_status && <Chip tone={environment.last_status === 'ok' ? 'working' : 'attention'}>{environment.last_status === 'ok' && environment.last_latency_ms !== null ? `ok · ${environment.last_latency_ms} ms` : environment.last_status}</Chip>}
          </div>
        )}
        {environment ? <PreviewFrame url={environment.url} /> : (
          <form className="flex max-w-120 flex-col gap-3" onSubmit={event => { event.preventDefault(); void addEnvironment(new FormData(event.currentTarget)); }}>
            <Text tone="muted">Name where the product runs to look at it here: staging, a preview branch, production.</Text>
            <Field label="Name"><Input name="name" placeholder="staging" required /></Field>
            <Field label="Address"><Input name="url" type="url" placeholder="https://staging.example.com" required /></Field>
            <div><Button variant="primary" type="submit">Add environment</Button></div>
          </form>
        )}
      </div>
      <SidePanel label="Snapshot and raised issues" side="right" wide>
        <div className="flex flex-col gap-2.5 px-1.5">
          <SectionLabel>New snapshot</SectionLabel>
          {snapshot
            ? <><MarkerCanvas src={`/api/attachments/${snapshot}`} markers={markers} onAdd={marker => setMarkers(current => [...current, marker].slice(0, 12))} /><Text size="caption" tone="muted">{markers.length} marker{markers.length === 1 ? '' : 's'} · click the image to mark a spot</Text></>
            : <Text size="small" tone="muted">Capture the page at the chosen size, or paste a screenshot of what you see.</Text>}
          {!pasted && latest?.state === 'requested' && <Text size="small" tone="muted">A worker is capturing the page…</Text>}
          {!pasted && latest?.state === 'failed' && <Text size="small" tone="stop">Capture failed: {latest.error ?? 'no reason given'}</Text>}
          <Textarea rows={3} aria-label="Describe the issue" placeholder="What is wrong, and where" value={text} onChange={event => setText(event.target.value)} />
          {error && <Text size="small" tone="stop">{error}</Text>}
          <div className="flex gap-1.5"><Button variant="primary" disabled={!snapshot || !text.trim()} onClick={() => { void send(); }}>Send to team</Button>{pasted && <Button variant="ghost" onClick={() => setPasted(null)}>Discard</Button>}</div>
          <SectionLabel>Raised from product</SectionLabel>
          {view.data?.raised.map(issue => <ListLink key={issue.id} href={`/p/${slug}/issues/${issue.number}`} mark={`#${issue.number}`} aside={<Chip tone={issue.state === 'closed' ? 'working' : 'attention'}>{issue.state === 'closed' ? 'closed' : 'open'}</Chip>}>{issue.title}</ListLink>)}
          {view.data?.raised.length === 0 && <Text size="small" tone="muted">Nothing raised yet.</Text>}
        </div>
      </SidePanel>
    </div>
  );
}
