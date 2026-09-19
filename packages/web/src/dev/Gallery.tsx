import { useState, type ReactNode } from 'react';
import type { Agent, Message as MessageData } from '../data/client';
import { AgentLine, Composer, Message, TaskCard } from '../patterns';
import { Avatar, Button, Card, Chip, Field, Icon, Input, Meter, SectionLabel, Segmented, StatTile, StatusDot, Text, type IconName } from '../ui';

const AGENT: Agent = { id: 'a', name: 'Maren', initials: 'MA', tint: '1', title: 'PM', persona: '', status: 'active', provider_id: null, model: null, is_pm: true, doing: 'Triaging your Safari report' };
const message = (kind: string, body: string, payload: Record<string, unknown> = {}): MessageData => ({ id: kind, seq: 1, authorKind: 'agent', authorId: 'a', kind, body, payload, createdAt: Date.UTC(2026, 8, 19, 14, 19) });
const AUTHOR = { name: 'Maren', initials: 'MA', tint: '1', role: 'PM' };
const ICONS: IconName[] = ['back', 'check', 'close', 'send', 'image', 'attach', 'chevron', 'link', 'search', 'menu'];

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return <Card className="flex flex-col gap-3"><SectionLabel>{title}</SectionLabel><div className="flex flex-wrap items-center gap-3">{children}</div></Card>;
}

// Every primitive and pattern with its variants: the visual reference for people and agents.
export function Gallery() {
  const [range, setRange] = useState<string>("month");
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-6">
      <Text as="h1" size="display">UI gallery</Text>
      <Specimen title="Type roles">
        {(['label', 'caption', 'small', 'body', 'title', 'heading', 'display', 'metric'] as const).map(size => <Text key={size} size={size}>{size === 'metric' ? '€ 392' : size}</Text>)}
      </Specimen>
      <Specimen title="Text tones">{(['ink', 'soft', 'muted', 'faint', 'accent', 'working', 'review', 'attention', 'stop'] as const).map(tone => <Text key={tone} tone={tone}>{tone}</Text>)}</Specimen>
      <Specimen title="Buttons">{(['primary', 'secondary', 'ghost', 'dashed', 'danger'] as const).map(variant => <Button key={variant} variant={variant}>{variant}</Button>)}<Button size="sm">small</Button><Button size="icon" aria-label="Send"><Icon name="send" /></Button><Button disabled>disabled</Button></Specimen>
      <Specimen title="Chips and status">{(['neutral', 'accent', 'working', 'review', 'attention', 'stop'] as const).map(tone => <Chip key={tone} tone={tone}>{tone}</Chip>)}<Chip pill>Team</Chip><Chip mono>CK-30</Chip>{(['working', 'review', 'attention', 'stop', 'idle', 'off'] as const).map(tone => <StatusDot key={tone} tone={tone} />)}</Specimen>
      <Specimen title="Avatars">{(['xs', 'sm', 'md', 'lg'] as const).map(size => <Avatar key={size} size={size} initials="AD" tint={2} />)}{Array.from({ length: 10 }, (_, index) => <Avatar key={index} initials="··" tint={index + 1} size="sm" />)}<Avatar initials="JF" tint="accent" status="working" /></Specimen>
      <Specimen title="Meters and tiles"><div className="w-40"><Meter value={0.65} tone="review" /></div><div className="w-40"><Meter thin value={0.68} /></div><StatTile label="Spend this month" value="€ 392" note="of € 600 budget" /></Specimen>
      <Specimen title="Controls"><Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'September' }]} /><div className="w-60"><Field label="Email"><Input placeholder="you@example.com" /></Field></div></Specimen>
      <Specimen title="Icons">{ICONS.map(name => <Text key={name} tone="soft"><Icon name={name} /></Text>)}</Specimen>
      <Specimen title="Patterns">
        <div className="w-64"><AgentLine agent={AGENT} /></div>
        <div className="w-64"><TaskCard task={{ id: 't', key: 'CK-28', title: 'Fix checkout double-submit on Safari', tag: 'ui', state: 'in_review', assignee_agent_id: 'a' }} owner={AGENT} /></div>
      </Specimen>
      <Card className="flex flex-col gap-3">
        <SectionLabel>Thread messages</SectionLabel>
        <Message author={AUTHOR} message={message('proposal', 'Disable the button optimistically on tap, with an 8 s timeout that re-enables it.')} />
        <Message author={{ ...AUTHOR, name: 'Cleo', initials: 'CL', tint: '4', role: 'QA' }} message={message('feedback', 'Hides a real failure if the request hangs. Condition: show an inline error on re-enable.', { stance: 'against' })} />
        <Message author={AUTHOR} message={message('decision', 'Ship it: key on mount, 8 s timeout re-enable. Cleo owns the hang test (CK-30).')} />
      </Card>
      <Card pad="none"><Composer placeholder="Raise an issue or suggestion…" action="Send to team" onSend={async () => {}} /></Card>
    </div>
  );
}
