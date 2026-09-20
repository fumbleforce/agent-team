import { useState, type ReactNode } from 'react';
import type { Agent, Message as MessageData } from '../data/client';
import { AgentLine, CommandPalette, Composer, EmptyState, EntityLink, Markdown, mentionOptions, Message, openPalette, TaskCard } from '../patterns';
import { Avatar, Button, Card, Checkbox, Chip, Dialog, Field, Icon, IconButton, Input, KeyValue, ListRow, Menu, Meter, Popover, SectionLabel, Segmented, Select, SelectMenu, StatTile, StatusDot, Text, Textarea, Tooltip, type IconName } from '../ui';

const AGENT: Agent = { id: 'a', name: 'Maren', initials: 'MA', tint: '1', title: 'PM', persona: '', status: 'active', provider_id: null, model: null, is_pm: true, doing: 'Triaging your Safari report', activity: 'working' };
const CLEO: Agent = { ...AGENT, id: 'c', name: 'Cleo', initials: 'CL', tint: '4', title: 'QA', is_pm: false, doing: null, activity: 'queued' };
const message = (kind: string, body: string, payload: Record<string, unknown> = {}): MessageData => ({ id: kind, seq: 1, authorKind: 'agent', authorId: 'a', kind, body, payload, createdAt: Date.UTC(2026, 8, 19, 14, 19) });
const AUTHOR = { name: 'Maren', initials: 'MA', tint: '1', role: 'PM' };
const ICONS: IconName[] = ['back', 'check', 'close', 'send', 'image', 'attach', 'chevron', 'link', 'search', 'menu'];
const SAMPLE = '## Checkout retries\n\nThe button is **disabled on tap** and re-enabled after `8 s`.\n\n- Key on mount\n- Inline error on re-enable\n\n> Cleo owns the hang test.\n\n```\nnpm run test:web\n```\n\n| Suite | State |\n| --- | --- |\n| unit | green |\n\n[The spec](https://example.com/spec) <script>window.galleryScriptRan = true</script><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="probe" onerror="window.galleryHandlerRan = true" style="position:fixed">';

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return <Card className="flex flex-col gap-3"><SectionLabel>{title}</SectionLabel><div className="flex flex-wrap items-center gap-3">{children}</div></Card>;
}

// Every primitive and pattern with its variants: the visual reference for people and agents.
export function Gallery() {
  const [range, setRange] = useState<string>('month');
  const [billing, setBilling] = useState<string>('metered');
  const [picked, setPicked] = useState('nothing yet');
  const [row, setRow] = useState('first');
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <Text as="h1" size="display">UI gallery</Text>
      <Specimen title="Type roles">
        {(['label', 'caption', 'small', 'body', 'title', 'heading', 'display', 'metric'] as const).map(size => <Text key={size} size={size}>{size === 'metric' ? '€ 392' : size}</Text>)}
      </Specimen>
      <Specimen title="Text tones">{(['ink', 'soft', 'muted', 'faint', 'accent', 'working', 'review', 'attention', 'stop'] as const).map(tone => <Text key={tone} tone={tone}>{tone}</Text>)}</Specimen>
      <Specimen title="Buttons">{(['primary', 'secondary', 'ghost', 'dashed', 'danger'] as const).map(variant => <Button key={variant} variant={variant}>{variant}</Button>)}<Button size="sm">small</Button><Button size="icon" aria-label="Send"><Icon name="send" /></Button><Button disabled>disabled</Button></Specimen>
      <Specimen title="Icon buttons">{(['ghost', 'secondary', 'primary', 'danger'] as const).map(variant => <IconButton key={variant} variant={variant} icon="link" label={`Copy link (${variant})`} />)}<IconButton icon="close" label="No hint" hint={false} /><IconButton icon="send" label="Disabled" disabled /></Specimen>
      <Specimen title="Chips and status">{(['neutral', 'accent', 'working', 'review', 'attention', 'stop'] as const).map(tone => <Chip key={tone} tone={tone}>{tone}</Chip>)}<Chip pill>Team</Chip><Chip mono>CK-30</Chip>{(['working', 'review', 'attention', 'stop', 'idle', 'off'] as const).map(tone => <StatusDot key={tone} tone={tone} />)}</Specimen>
      <Specimen title="Avatars">{(['xs', 'sm', 'md', 'lg'] as const).map(size => <Avatar key={size} size={size} initials="AD" tint={2} />)}{Array.from({ length: 10 }, (_, index) => <Avatar key={index} initials="··" tint={index + 1} size="sm" />)}<Avatar initials="JF" tint="accent" status="working" /></Specimen>
      <Specimen title="Cards">{(['card', 'raised', 'decision', 'outline'] as const).map(tone => <Card key={tone} tone={tone} pad="sm"><Text size="small">{tone}</Text></Card>)}</Specimen>
      <Specimen title="Meters and tiles"><div className="w-40"><Meter value={0.65} tone="review" /></div><div className="w-40"><Meter thin value={0.68} /></div><div className="w-40"><Meter value={0.9} tone="attention" /></div><StatTile label="Spend this month" value="€ 392" note="of € 600 budget" /></Specimen>
      <Specimen title="Controls">
        <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'September' }]} />
        <div className="w-60"><Field label="Email"><Input placeholder="you@example.com" /></Field></div>
        <div className="w-60"><Field label="With an error" error="Required"><Input /></Field></div>
        <div className="w-60"><Field label="Notes"><Textarea rows={2} placeholder="Textarea" /></Field></div>
        <div className="flex flex-col gap-2"><Checkbox label="Publishing authorized" note="Recorded in the manifest" defaultChecked /><Checkbox label="Unchecked" /><Checkbox label="Disabled" disabled /></div>
      </Specimen>
      <Specimen title="Select: native and menu">
        <div className="w-44"><Field label="Native"><Select defaultValue="metered"><option>metered</option><option>subscription</option></Select></Field></div>
        <Select compact aria-label="Native compact"><option>compact</option></Select>
        <div className="w-44"><SelectMenu label="Billing" value={billing} onChange={setBilling} options={[{ value: 'metered', label: 'Metered' }, { value: 'subscription', label: 'Subscription' }, { value: 'local', label: 'Local', disabled: true }]} /></div>
        <SelectMenu compact label="Compact billing" value={billing} onChange={setBilling} options={[{ value: 'metered', label: 'Metered' }, { value: 'subscription', label: 'Subscription' }]} />
        <div className="w-44"><SelectMenu label="Empty" value={undefined} onChange={() => {}} placeholder="Choose…" options={[{ value: 'a', label: 'Option A' }]} /></div>
      </Specimen>
      <Specimen title="Menu, popover, tooltip, dialog">
        <Menu trigger={<Button>Task actions</Button>} label="CK-28" items={[{ label: 'Reassign', onSelect: () => setPicked('Reassign') }, { label: 'Defer', onSelect: () => setPicked('Defer'), aside: <Chip mono>D</Chip> }, { label: 'Unavailable', onSelect: () => {}, disabled: true }, 'separator', { label: 'Quarantine', tone: 'danger', onSelect: () => setPicked('Quarantine') }]} />
        <Text size="small" tone="muted">picked: {picked}</Text>
        <Popover label="Budget" trigger={<Button>Open popover</Button>}><div className="flex flex-col gap-1.5"><Text size="small" weight="semibold">Budget</Text><Text size="small" tone="soft">€ 392 of € 600 spent this month.</Text></div></Popover>
        <Tooltip content="Shown on hover and on focus"><Button variant="ghost">Hover for a tooltip</Button></Tooltip>
        <Dialog trigger={<Button>Open dialog</Button>} title="Retire this agent?" description="Its open work returns to the backlog." footer={<Button variant="danger">Retire</Button>}><Text size="small" tone="soft">Nothing is deleted; the trace stays readable.</Text></Dialog>
        <Dialog trigger={<Button>Open drawer</Button>} title="Drawer" place="left"><div className="w-54 p-4"><Text size="small" tone="soft">The narrow shell puts the sidebar here.</Text></div></Dialog>
      </Specimen>
      <Specimen title="List rows and key-values">
        <div className="flex w-64 flex-col gap-0.5">
          <ListRow leading={<Avatar initials="MA" tint={1} size="sm" />} title="As a button" note="with a note" aside={<Chip>3</Chip>} active={row === 'first'} onClick={() => setRow('first')} />
          <ListRow title="Another button" active={row === 'second'} onClick={() => setRow('second')} />
          <ListRow title="As a link" href="/dev/ui" aside={<Icon name="link" size={12} />} />
          <ListRow title="Plain" note="not interactive" />
        </div>
        <dl className="m-0 flex w-56 flex-col gap-1.5"><KeyValue label="Branch" mono>task/ck-28</KeyValue><KeyValue label="Owner">Maren</KeyValue><KeyValue label="Stacked" stack>Value under its name</KeyValue></dl>
      </Specimen>
      <Specimen title="Icons">{ICONS.map(name => <Text key={name} tone="soft"><Icon name={name} /></Text>)}</Specimen>
      <Specimen title="Patterns">
        <div className="w-64"><AgentLine agent={AGENT} /></div>
        <div className="w-64"><TaskCard task={{ id: 't', key: 'CK-28', title: 'Fix checkout double-submit on Safari', tag: 'ui', state: 'in_review', assignee_agent_id: 'a' }} owner={AGENT} /></div>
      </Specimen>
      <Specimen title="Entity links">
        <EntityLink kind="project" href="/dev/ui">Checkout v2</EntityLink><EntityLink kind="agent" href="/dev/ui">Maren</EntityLink><EntityLink kind="task" href="/dev/ui" code="CK-28">Fix double-submit</EntityLink>
        <EntityLink kind="issue" href="/dev/ui" code="118">Safari report</EntityLink><EntityLink kind="page" href="/dev/ui">Runbook</EntityLink><EntityLink kind="proposal" href="/dev/ui">Add a QA seat</EntityLink><EntityLink kind="role" href="/dev/ui">Reviewer</EntityLink>
      </Specimen>
      <Specimen title="Command palette"><Button onClick={openPalette}><Icon name="search" />Open the palette</Button><Text size="small" tone="muted">or Ctrl / Cmd + K</Text></Specimen>
      <CommandPalette projects={[{ id: 'p', slug: 'web-shop', name: 'Web shop', kind: 'repo', status: 'active', team: { id: 't', name: 'Core', seats: 5 }, progress: 0.6, subprojects: [{ id: 's', slug: 'checkout-v2', name: 'Checkout v2', progress: 0.4 }] }]} agents={[AGENT, CLEO]} pages={[{ href: '/dev/ui', label: 'Runbook', note: 'ops/runbook.md' }]} screens={[{ href: '/dev/ui', label: 'UI gallery' }, { href: '/costs', label: 'Costs' }]} />
      <Card className="flex flex-col gap-3"><SectionLabel>Empty state</SectionLabel><EmptyState title="No pages yet" note="Agents write pages as they learn. You can promote a memory to start one."><Button variant="primary">Write the first page</Button></EmptyState><EmptyState title="Without an action" /></Card>
      <Card className="flex flex-col gap-3"><SectionLabel>Markdown (sanitized)</SectionLabel><Markdown>{SAMPLE}</Markdown><SectionLabel>Small, as in a message</SectionLabel><Markdown size="small">{'Ship it, *with* the `8 s` timeout.'}</Markdown></Card>
      <Card className="flex flex-col gap-3">
        <SectionLabel>Thread messages</SectionLabel>
        <Message author={AUTHOR} message={message('proposal', 'Disable the button optimistically on tap, with an 8 s timeout that re-enables it.')} />
        <Message author={{ ...AUTHOR, name: 'Cleo', initials: 'CL', tint: '4', role: 'QA' }} message={message('feedback', 'Hides a real failure if the request hangs. Condition: show an inline error on re-enable.', { stance: 'against' })} />
        <Message author={AUTHOR} message={message('decision', 'Ship it: key on mount, 8 s timeout re-enable. Cleo owns the hang test (CK-30).')} />
      </Card>
      <Card pad="none" className="pt-24"><Composer placeholder="Composer with @mention and image paste — type @ to try…" action="Send to team" mentions={mentionOptions([AGENT, CLEO])} onAttach={async file => ({ id: String(file.size), name: file.name || 'pasted-image.png' })} onSend={async () => {}} /></Card>
      <Card pad="none"><Composer placeholder="Plain composer…" action="Reply" onSend={async () => {}} /></Card>
    </div>
  );
}
