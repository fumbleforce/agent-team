import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, type Me, type ProjectNode } from '../../data/client';
import { AppShell, PageHeader, Sidebar, type Crumb } from '../../patterns';
import { Tabs, Text } from '../../ui';
import { OrgChat } from '../orgchat/OrgChat';

export const isOrgAdmin = (me: Me): boolean => me.user.orgRole === 'owner' || me.user.orgRole === 'admin';
const SECTIONS = [{ href: '/org', label: 'Organization', admin: false }, { href: '/roles', label: 'Roles', admin: false }, { href: '/skills', label: 'Skills', admin: false }, { href: '/library', label: 'Agent library', admin: false }, { href: '/settings/members', label: 'Members', admin: true }, { href: '/settings/auth', label: 'Sign-in', admin: true }, { href: '/audit', label: 'Audit', admin: true }];
export const orgLinks = (me: Me) => SECTIONS.filter(section => !section.admin || isOrgAdmin(me)).map(({ href, label }) => ({ href, label }));

// The frame of every organization-level page: the sidebar, the title and the tabs between those pages.
export function OrgShell({ me, projects, title, active, crumbs, children }: { me: Me; projects: ProjectNode[]; title: string; active: string | null; crumbs?: Crumb[]; children: ReactNode }) {
  const sidebar = <Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} links={[{ href: '/proposals', label: 'Team proposals' }, { href: '/costs', label: 'Costs' }]} />;
  return (
    <AppShell sidebar={sidebar} rail={isOrgAdmin(me) ? <OrgChat /> : undefined} railLabel="Chief of staff">
      <PageHeader title={title} crumbs={crumbs ?? [{ label: me.org?.name ?? 'Organization', href: '/org' }]}>
        <Tabs items={orgLinks(me).map(link => ({ ...link, active: link.href === active }))} />
      </PageHeader>
      {children}
    </AppShell>
  );
}

// One Idempotency-Key per thing being created: a double click or a retry repeats the key, the next creation gets a new one.
export function useCreateKey(): { headers(): Record<string, string>; renew(): void } {
  const key = useRef(crypto.randomUUID());
  return { headers: () => ({ 'idempotency-key': key.current }), renew: () => { key.current = crypto.randomUUID(); } };
}

// Runs a form's action with its fields, shows what the server refused, and clears the form when it worked.
export function useAction() {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await action(); return true; } catch (failure) { setError(failure instanceof ApiError ? failure : new ApiError(0, 'error', 'Something went wrong')); return false; } finally { setBusy(false); }
  };
  const submit = (action: (form: FormData) => Promise<unknown>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void run(() => action(new FormData(form))).then(ok => { if (ok) form.reset(); });
  };
  return { error, busy, run, submit };
}
export const ActionError = ({ error }: { error: ApiError | null }) => (error ? <Text size="small" tone="stop">{error.status === 412 ? 'Someone else changed this. Reload and try again.' : error.message}</Text> : null);
