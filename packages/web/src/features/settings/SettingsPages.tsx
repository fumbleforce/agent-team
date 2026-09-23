import { useState } from 'react';
import { api, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { DataTable, EmptyState, SettingsBody, SettingsSection } from '../../patterns';
import { Button, Card, Chip, CodeBlock, Field, Input, Select, StatusDot, Text } from '../../ui';
import { ActionError, isOrgAdmin, OrgShell, useAction, useCreateKey } from '../org/OrgShell';
import { SsoCard, SsoSetupFlow, type SsoCatalog } from './SsoSetup';

interface Grant { projectId: string; slug: string; name: string; role: string }
interface User { id: string; email: string; name: string; orgRole: string; status: string; signIn: string[]; lastLoginAt: number | null; projects: Grant[] }
interface Invite { id: string; email: string; orgRole: string; projects: { projectId: string; role: string }[]; expiresAt: number; invitedBy: string | null }
interface AuthSettings { password: { minimumLength: number }; trustedHeader: { enabled: boolean; header: string | null }; secureCookies: boolean; canEdit: boolean }
interface MachineToken { id: string; name: string; kind: string; createdBy: string | null; createdAt: number; revokedAt: number | null; lastUsedAt: number | null }

const day = (at: number | null) => (at ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'never');
const AdminsOnly = ({ me, projects, title }: { me: Me; projects: ProjectNode[]; title: string }) => <OrgShell me={me} projects={projects} title={title} active={null}><SettingsBody><EmptyState title="For administrators" note="Ask an owner or admin for access." /></SettingsBody></OrgShell>;

export function MembersPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const members = useResource<{ users: User[]; invites: Invite[] }>(isOrgAdmin(me) ? '/api/users' : null);
  const change = useAction(), invite = useAction(), grant = useAction(), inviteKey = useCreateKey();
  const [link, setLink] = useState<string | null>(null);
  if (!isOrgAdmin(me)) return <AdminsOnly me={me} projects={projects} title="Members" />;
  const owner = me.user.orgRole === 'owner';
  // Admins manage members and viewers; the owner manages everyone but themselves.
  const editable = (user: User) => user.id !== me.user.id && (owner || (user.orgRole !== 'owner' && user.orgRole !== 'admin'));
  const patch = (user: User, body: Record<string, string>) => { void change.run(() => api(`/api/users/${user.id}`, body)).then(members.reload); };
  const projectOptions = projects.map(project => <option key={project.id} value={project.slug}>{project.name}</option>);

  return (
    <OrgShell me={me} projects={projects} title="Members" active="/settings/members">
      <SettingsBody>
        <SettingsSection title={`People · ${members.data?.users.length ?? 0}`}>
          <DataTable rows={members.data?.users ?? []} rowKey={user => user.id} columns={[
            { label: 'Person', width: 'lg', cell: user => <span className="flex min-w-0 flex-col"><Text weight="medium" truncate>{user.name}{user.id === me.user.id ? ' (you)' : ''}</Text><Text size="caption" tone="muted" truncate>{user.email}</Text></span> },
            { label: 'Role', width: 'sm', cell: user => (editable(user)
              ? <Select compact aria-label={`Organization role of ${user.name}`} value={user.orgRole} onChange={event => patch(user, { orgRole: event.target.value })}>{(owner ? ['owner', 'admin', 'member', 'viewer'] : ['member', 'viewer']).map(role => <option key={role} value={role}>{role}</option>)}</Select>
              : <Chip tone={user.orgRole === 'owner' ? 'accent' : 'neutral'}>{user.orgRole}</Chip>) },
            { label: 'Projects', width: 'grow', cell: user => <span className="flex flex-wrap gap-1">{user.projects.map(item => <Chip key={item.projectId}>{item.name} · {item.role}</Chip>)}{user.projects.length === 0 && <Text size="caption" tone="faint">{user.orgRole === 'owner' || user.orgRole === 'admin' ? 'all projects' : 'none'}</Text>}</span> },
            { label: 'Signs in with', width: 'sm', cell: user => <Text size="caption" tone="muted">{user.signIn.join(', ') || 'trusted header'}</Text> },
            { label: 'Last sign-in', width: 'sm', cell: user => <Text size="caption" tone="muted" mono>{day(user.lastLoginAt)}</Text> },
            { label: 'Account', width: 'sm', cell: user => (editable(user) ? <Button size="sm" variant={user.status === 'active' ? 'ghost' : 'secondary'} onClick={() => patch(user, { status: user.status === 'active' ? 'disabled' : 'active' })}>{user.status === 'active' ? 'Disable' : 'Enable'}</Button> : <Text size="caption" tone="muted">{user.status}</Text>) },
          ]} />
          <ActionError error={change.error} />
        </SettingsSection>

        <SettingsSection title="Project grants">
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={grant.submit(async form => { await api(`/api/projects/${String(form.get('project'))}/members`, { userId: form.get('user'), role: form.get('role') === 'none' ? null : form.get('role') }); members.reload(); })}>
            <Field label="Person"><Select name="user">{members.data?.users.filter(user => user.orgRole !== 'owner' && user.orgRole !== 'admin').map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</Select></Field>
            <Field label="Project"><Select name="project">{projectOptions}</Select></Field>
            <Field label="Role"><Select name="role"><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option><option value="none">no access</option></Select></Field>
            <Button type="submit" disabled={grant.busy}>Set grant</Button>
          </form>
          <ActionError error={grant.error} />
        </SettingsSection>

        <SettingsSection title="Invitations" note="Single-use links, good for seven days. Copy the link to the person.">
          <DataTable rows={members.data?.invites ?? []} rowKey={item => item.id} empty={<Text size="small" tone="muted">Nobody is waiting on an invitation.</Text>} columns={[
            { label: 'Email', width: 'lg', cell: item => <Text size="small" truncate>{item.email}</Text> },
            { label: 'Role', width: 'sm', cell: item => <Chip>{item.orgRole}</Chip> },
            { label: 'Projects', width: 'grow', cell: item => <span className="flex flex-wrap gap-1">{item.projects.map(entry => <Chip key={entry.projectId}>{projects.find(project => project.id === entry.projectId)?.name ?? 'project'} · {entry.role}</Chip>)}</span> },
            { label: 'Expires', width: 'sm', cell: item => <Text size="caption" tone="muted" mono>{day(item.expiresAt)}</Text> },
            { label: '', width: 'sm', cell: item => <Button size="sm" variant="ghost" onClick={() => { void change.run(() => api(`/api/invites/${item.id}/revoke`, {})).then(members.reload); }}>Revoke</Button> },
          ]} />
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={invite.submit(async form => {
            const project = projects.find(item => item.slug === form.get('project'));
            const created = await api<{ path: string }>('/api/invites', { email: form.get('email'), orgRole: form.get('orgRole'), projects: project ? [{ projectId: project.id, role: form.get('projectRole') }] : [] }, inviteKey.headers());
            inviteKey.renew(); setLink(new URL(created.path, window.location.origin).href); members.reload();
          })}>
            <Field label="Email" error={invite.error?.fields.email}><Input name="email" type="email" required placeholder="person@example.com" /></Field>
            <Field label="Organization role"><Select name="orgRole" defaultValue="member">{owner && <option value="admin">admin</option>}<option value="member">member</option><option value="viewer">viewer</option></Select></Field>
            <Field label="Project"><Select name="project"><option value="">none yet</option>{projectOptions}</Select></Field>
            <Field label="Role there"><Select name="projectRole" defaultValue="member"><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option></Select></Field>
            <Button type="submit" variant="primary" disabled={invite.busy}>Create invitation</Button>
          </form>
          <ActionError error={invite.error} />
          {link && <Card tone="decision" pad="sm" className="flex flex-wrap items-center gap-2.5"><Text size="small" mono className="min-w-0 grow break-all">{link}</Text><Button size="sm" onClick={() => { void navigator.clipboard.writeText(link); }}>Copy link</Button></Card>}
        </SettingsSection>
      </SettingsBody>
    </OrgShell>
  );
}

// Your own password. The owner of a coordinator on this machine has none and is never asked for one; setting one is what lets that
// account sign in once the organization moves to a hosted coordinator.
function YourPassword() {
  const state = useResource<{ has: boolean }>('/api/me/password');
  const action = useAction();
  const [done, setDone] = useState(false);
  if (!state.data) return null;
  return (
    <SettingsSection title="Your password" {...(state.data.has ? {} : { note: 'You sign in on this machine without one. Set one before this organization moves to a hosted coordinator.' })}>
      <form className="flex flex-wrap items-end gap-2.5" onSubmit={action.submit(async form => { await api('/api/me/password', { current: state.data?.has ? String(form.get('current') ?? '') : null, next: String(form.get('next') ?? '') }); setDone(true); state.reload(); })}>
        {state.data.has && <Field label="Current password"><Input name="current" type="password" autoComplete="current-password" required /></Field>}
        <Field label={state.data.has ? 'New password' : 'Password'} error={action.error?.fields.next}><Input name="next" type="password" autoComplete="new-password" minLength={12} required /></Field>
        <Button type="submit" variant="primary" disabled={action.busy}>{state.data.has ? 'Change it' : 'Set it'}</Button>
      </form>
      {done && !action.error && <Text size="small" tone="muted">Saved.</Text>}
      <ActionError error={action.error} />
    </SettingsSection>
  );
}

export function AuthPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const auth = useResource<AuthSettings>(isOrgAdmin(me) ? '/api/settings/auth' : null);
  const sso = useResource<SsoCatalog>(isOrgAdmin(me) ? '/api/settings/sso/catalog' : null);
  const tokens = useResource<{ tokens: MachineToken[] }>(isOrgAdmin(me) ? '/api/machine-tokens' : null);
  const machine = useAction(), tokenKey = useCreateKey();
  const [secret, setSecret] = useState<string | null>(null);
  if (!isOrgAdmin(me)) return <AdminsOnly me={me} projects={projects} title="Sign-in" />;
  const data = auth.data;

  return (
    <OrgShell me={me} projects={projects} title="Sign-in" active="/settings/auth">
      <SettingsBody>
        <YourPassword />
        <SettingsSection title="Passwords">
          <Card tone="raised" pad="sm" className="flex flex-col gap-1">
            <Text size="small" tone="soft">A password has at least {data?.password.minimumLength ?? 12} characters.</Text>
            <Text size="small" tone="soft">8 failed sign-ins lock an account for 15 minutes.</Text>
            <Text size="small" tone="soft">{data?.secureCookies ? 'Sign-in cookies only travel over HTTPS.' : 'Served over plain HTTP. Fine on your own machine; put it behind HTTPS before others use it.'}</Text>
          </Card>
        </SettingsSection>

        <SettingsSection title="Single sign-on" note={sso.data && !sso.data.canEdit ? 'Only the owner changes how people sign in.' : 'Let people sign in with the account they already have at work, next to passwords.'} aside={<Chip tone={sso.data?.current ? 'working' : 'neutral'}>{sso.data?.current ? 'on' : 'off'}</Chip>}>
          {sso.data?.current && <SsoCard current={sso.data.current} canEdit={sso.data.canEdit} onChange={sso.reload} />}
          {sso.data && !sso.data.current && (sso.data.canEdit
            ? <div className="flex"><SsoSetupFlow catalog={sso.data} onDone={sso.reload} /></div>
            : <Text size="small" tone="muted">Not set up. People sign in with a password.</Text>)}
        </SettingsSection>

        {data?.trustedHeader.enabled && <SettingsSection title="Sign-in through a proxy on this machine">
          <Card tone="raised" pad="sm" className="flex items-center gap-2"><StatusDot tone={data?.trustedHeader.enabled ? 'working' : 'off'} /><Text size="small">{data?.trustedHeader.enabled ? 'On' : 'Off'}</Text>{data?.trustedHeader.header && <Chip mono>{data.trustedHeader.header}</Chip>}</Card>
        </SettingsSection>}

        <SettingsSection title="Tokens for workers and the command line" note="One per machine, so one can be revoked without stopping the others.">
          <DataTable rows={tokens.data?.tokens ?? []} rowKey={token => token.id} empty={<Text size="small" tone="muted">No tokens yet. Only the token the coordinator was started with is accepted.</Text>} columns={[
            { label: 'Name', width: 'grow', cell: token => <Text size="small" weight="medium" truncate>{token.name}</Text> },
            { label: 'For', width: 'sm', cell: token => <Chip>{token.kind === 'cli' ? 'command line' : token.kind}</Chip> },
            { label: 'Created', cell: token => <Text size="caption" tone="muted">{day(token.createdAt)}{token.createdBy ? ` by ${token.createdBy}` : ''}</Text> },
            { label: 'Last used', width: 'sm', cell: token => <Text size="caption" tone="muted" mono>{day(token.lastUsedAt)}</Text> },
            { label: '', width: 'sm', cell: token => (token.revokedAt ? <Chip tone="stop">revoked</Chip> : <Button size="sm" variant="danger" onClick={() => { void machine.run(() => api(`/api/machine-tokens/${token.id}/revoke`, {})).then(tokens.reload); }}>Revoke</Button>) },
          ]} />
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={machine.submit(async form => { const created = await api<{ token: string }>('/api/machine-tokens', { name: form.get('name'), kind: form.get('kind') }, tokenKey.headers()); tokenKey.renew(); setSecret(created.token); tokens.reload(); })}>
            <Field label="Name" error={machine.error?.fields.name}><Input name="name" required maxLength={60} placeholder="build box" /></Field>
            <Field label="For"><Select name="kind"><option value="worker">worker</option><option value="cli">command line</option></Select></Field>
            <Button type="submit" disabled={machine.busy}>Create token</Button>
          </form>
          <ActionError error={machine.error} />
          {secret && (
            <Card tone="decision" pad="sm" className="flex flex-col gap-2">
              <Text size="small" tone="attention">Copy this token now; it is not shown again.</Text>
              <CodeBlock text={secret} />
              <div className="flex"><Button size="sm" variant="ghost" onClick={() => setSecret(null)}>Done, I copied it</Button></div>
            </Card>
          )}
        </SettingsSection>
      </SettingsBody>
    </OrgShell>
  );
}
