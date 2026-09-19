import { Command } from 'cmdk';
import type { ReactNode } from 'react';
import { useLocation } from 'wouter';
import { Avatar, Dialog, Icon, Text } from '../ui';
import type { CommandPaletteProps } from './CommandPalette';

// Every typed word must occur in the entry; an entry whose name starts with the search comes first. Plain and predictable,
// where fuzzy matching ranks "Customer support" above "Costs" for "costs".
const rank = (value: string, search: string) => {
  const entry = value.toLowerCase(), words = search.toLowerCase().split(' ').filter(Boolean);
  if (!words.every(word => entry.includes(word))) return 0;
  return entry.startsWith(words[0] ?? '') ? 1 : 0.5;
};

const ITEM = 'flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2 aria-selected:bg-active';
const heading = (text: string) => <div className="px-2.5 pt-2 pb-1"><Text size="label">{text}</Text></div>;

export function CommandPaletteBody({ projects, agents, pages = [], screens, open, setOpen }: CommandPaletteProps & { open: boolean; setOpen(open: boolean): void }) {
  const [, navigate] = useLocation();
  const go = (href: string) => { setOpen(false); navigate(href); };
  const item = (href: string, keywords: string, leading: ReactNode, label: string, note?: string) => (
    <Command.Item key={href} value={`${label} ${keywords} ${href}`} onSelect={() => go(href)} className={ITEM}>
      {leading}<Text size="small" truncate>{label}</Text>{note && <Text size="caption" tone="muted" mono truncate className="ml-auto">{note}</Text>}
    </Command.Item>
  );
  const mark = (text: string) => <Text size="caption" tone="faint" mono className="w-6 text-center">{text}</Text>;
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a project, an agent, a page or a screen" place="top">
      <Command label="Command palette" loop filter={rank} className="flex max-h-100 flex-col">
        <div className="flex items-center gap-2.5 border-b border-line px-4 text-ink-muted">
          <Icon name="search" />
          <Command.Input autoFocus placeholder="Jump to…" className="h-11 grow bg-transparent text-body text-ink outline-none placeholder:text-ink-faint" />
          <Text size="caption" tone="faint" mono>esc</Text>
        </div>
        <Command.List className="min-h-0 overflow-y-auto p-1.5">
          <Command.Empty className="px-2.5 py-6 text-center text-small text-ink-muted">Nothing matches.</Command.Empty>
          {projects.length > 0 && (
            <Command.Group heading={heading('Projects')}>
              {projects.flatMap(project => [
                item(`/p/${project.slug}/tasks`, 'project', mark('▣'), project.name, project.team?.name),
                ...project.subprojects.map(sub => item(`/p/${sub.slug}/tasks`, `project ${project.name}`, mark('└'), sub.name, project.name)),
              ])}
            </Command.Group>
          )}
          {agents.length > 0 && <Command.Group heading={heading('Agents')}>{agents.map(agent => item(`/agents/${agent.id}`, `agent ${agent.title}`, <Avatar initials={agent.initials} tint={agent.tint} size="sm" />, agent.name, agent.title))}</Command.Group>}
          {pages.length > 0 && <Command.Group heading={heading('Pages')}>{pages.map(page => item(page.href, 'page knowledge', mark('¶'), page.label, page.note))}</Command.Group>}
          <Command.Group heading={heading('Screens')}>{screens.map(screen => item(screen.href, 'screen go to', mark('→'), screen.label, screen.note))}</Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  );
}
