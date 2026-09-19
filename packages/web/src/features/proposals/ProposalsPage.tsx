import { useState } from 'react';
import { api, type Agent, type Me, type ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, ListLink, PageHeader, Sidebar, SidePanel, VoteLine } from '../../patterns';
import { Button, Card, Chip, SectionLabel, StatTile, Text, type ChipTone } from '../../ui';

interface Proposal { id: string; category: string; title: string; why: string; whatChanges: string; evidence: { label: string; value: string }[]; proposerAgentId: string; state: string; resolutionNote: string | null; votes: { agentId: string; stance: string; note: string }[] }
const STATE: Record<string, { label: string; tone: ChipTone }> = { needs_you: { label: 'needs you', tone: 'attention' }, auto_applied: { label: 'auto-applied', tone: 'working' }, approved: { label: 'approved', tone: 'neutral' }, declined: { label: 'declined', tone: 'stop' }, voting: { label: 'voting', tone: 'review' } };

export function ProposalsPage({ id, me, projects, agents }: { id: string | null; me: Me; projects: ProjectNode[]; agents: Agent[] }) {
  const list = useResource<{ proposals: Proposal[] }>('/api/proposals');
  const [busy, setBusy] = useState(false);
  useStream(event => event.type.startsWith('proposal.'), list.reload);
  const items = list.data?.proposals ?? [];
  const selected = items.find(item => item.id === id) ?? items.find(item => item.state === 'needs_you') ?? items[0];
  const agent = (agentId: string) => agents.find(item => item.id === agentId);
  const decide = async (decision: 'approve' | 'decline') => { if (!selected) return; setBusy(true); await api(`/api/proposals/${selected.id}/decide`, { decision }).finally(() => setBusy(false)); list.reload(); };

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title="Team proposals" crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }]} />
      <div className="flex min-h-0 grow">
        <SidePanel label="Proposals" wide>
          {items.map(item => <ListLink key={item.id} href={`/proposals/${item.id}`} active={item.id === selected?.id} aside={<Chip tone={STATE[item.state]?.tone ?? 'neutral'}>{STATE[item.state]?.label ?? item.state}</Chip>}>{item.title}</ListLink>)}
          {items.length === 0 && <div className="p-2"><Text size="small" tone="muted">The team has not proposed anything yet.</Text></div>}
        </SidePanel>
        {selected && (
          <div className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-6 py-5">
            <div className="flex items-start gap-3.5">
              <div className="flex min-w-0 grow flex-col gap-1.5">
                <div className="flex items-center gap-2"><Chip tone="review">{selected.category}</Chip><Text as="h2" size="heading">{selected.title}</Text></div>
                <Text size="small" tone="muted">Proposed by {agent(selected.proposerAgentId)?.name ?? 'an agent'}{selected.resolutionNote ? ` · ${selected.resolutionNote}` : ''}</Text>
              </div>
              {selected.state === 'needs_you' && <div className="flex gap-1.5"><Button variant="primary" disabled={busy} onClick={() => decide('approve')}>Approve</Button><Button disabled={busy} onClick={() => decide('decline')}>Decline</Button></div>}
            </div>
            <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
              <Card className="flex flex-col gap-2"><Text weight="semibold">Why</Text><Text tone="soft">{selected.why}</Text><Text weight="semibold">What changes</Text><Text tone="soft">{selected.whatChanges}</Text></Card>
              <Card className="flex flex-col gap-2.5"><SectionLabel>Team view</SectionLabel>{selected.votes.map(vote => <VoteLine key={vote.agentId} agent={agent(vote.agentId)} stance={vote.stance} note={vote.note} />)}{selected.votes.length === 0 && <Text size="small" tone="muted">No votes yet.</Text>}</Card>
            </div>
            {selected.evidence.length > 0 && <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">{selected.evidence.map(item => <StatTile key={item.label} label={item.label} value={item.value} />)}</div>}
          </div>
        )}
      </div>
    </AppShell>
  );
}
