import { api, type Me, type ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, Attachment, PageHeader, Sidebar, SidePanel } from '../../patterns';
import { Button, Card, Chip, SectionLabel, StatusDot, Text } from '../../ui';

interface Connection { id: string; name: string; category: string; mode: string; status: string; statusDetail: string | null; credentialRef: string | null }
interface Handoff { id: string; source: string; title: string; summary: string; attachmentId: string | null; state: string; direction: string }
const CATEGORY: Record<string, string> = { 'issue-boards': 'Issue boards', code: 'Code', comms: 'Comms', storage: 'Storage & knowledge', 'ai-workspaces': 'AI workspaces', media: 'Media & generation', business: 'Business & ops', other: 'Anything else' };
const TONE = { connected: 'working', warning: 'attention', off: 'off' } as const;

export function IntegrationsPage({ slug, me, projects }: { slug: string; me: Me; projects: ProjectNode[] }) {
  const view = useResource<{ connections: Connection[]; handoffs: Handoff[] }>(`/api/projects/${slug}/integrations`);
  useStream(event => event.type.startsWith('handoff.') || event.type.startsWith('connection.'), view.reload);
  const groups = Object.keys(CATEGORY).map(key => ({ key, items: view.data?.connections.filter(item => item.category === key) ?? [] })).filter(group => group.items.length);
  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={slug} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title="Integrations" crumbs={[slug]} />
      <div className="flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col gap-3 overflow-y-auto px-5 py-3.5">
          {groups.map(group => (
            <section key={group.key} className="flex flex-col gap-1.5">
              <SectionLabel>{CATEGORY[group.key]}</SectionLabel>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map(item => (
                  <Card key={item.id} tone="raised" pad="sm" className="flex flex-col gap-1">
                    <div className="flex items-center gap-2"><StatusDot tone={TONE[item.status as keyof typeof TONE] ?? 'off'} /><Text weight="semibold">{item.name}</Text><Text size="caption" tone="muted" className="ml-auto whitespace-nowrap">{item.mode}</Text></div>
                    <Text size="caption" tone="muted" mono truncate>{item.statusDetail ?? item.credentialRef ?? ''}</Text>
                  </Card>
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && <Text tone="muted">Nothing connected yet. The project's manifest lists what the team may reach; connections added here name where their credential lives on the workers.</Text>}
        </div>
        <SidePanel label="Handoffs" side="right" wide>
          <div className="flex flex-col gap-2.5 px-1.5">
            <SectionLabel>Handoffs</SectionLabel>
            <Text size="caption" tone="muted">Work done elsewhere, brought to the team with its context.</Text>
            {view.data?.handoffs.map(handoff => (
              <Card key={handoff.id} tone={handoff.state === 'new' ? 'decision' : 'raised'} pad="sm" className="flex flex-col gap-2">
                <div className="flex items-center gap-2"><Chip mono>{handoff.source}</Chip><Text size="small" weight="semibold" truncate>{handoff.title}</Text></div>
                {handoff.summary && <Text size="small" tone="soft">{handoff.summary}</Text>}
                {handoff.attachmentId && <Attachment id={handoff.attachmentId} />}
                {handoff.state === 'new' ? <div><Button variant="primary" onClick={() => { void api(`/api/projects/${slug}/handoffs/${handoff.id}/hand`, {}).then(view.reload); }}>Hand to team</Button></div> : <Text size="caption" tone="muted">{handoff.state}</Text>}
              </Card>
            ))}
            {view.data?.handoffs.length === 0 && <Text size="small" tone="muted">Nothing handed over yet.</Text>}
          </div>
        </SidePanel>
      </div>
    </AppShell>
  );
}
