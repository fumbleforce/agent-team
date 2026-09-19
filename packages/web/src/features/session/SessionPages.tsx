import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { CenteredPanel } from '../../patterns';
import { Button, Field, Input, Text } from '../../ui';

interface FieldSpec { name: string; label: string; type?: string; autoComplete?: string }

// One form for sign-in, first-run setup and accepting an invitation; they differ only in fields and endpoint.
function SessionForm({ title, note, fields, action, endpoint, extra, sso }: { title: string; note?: string; fields: FieldSpec[]; action: string; endpoint: string; extra?: Record<string, unknown>; sso?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(null); setRefused({});
    try {
      await api(endpoint, { ...Object.fromEntries(new FormData(event.currentTarget)), ...extra });
      window.location.assign('/');
    } catch (failure) {
      // A refused field is shown under that field; anything else (wrong password, a lockout, an expired link) above the button.
      const fields = failure instanceof ApiError ? failure.fields : {};
      setRefused(fields);
      setError(failure instanceof ApiError ? (Object.keys(fields).length ? 'Check the marked fields.' : failure.message) : 'Something went wrong');
      setBusy(false);
    }
  };
  return (
    <CenteredPanel title={title} {...(note ? { note } : {})}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        {fields.map(field => <Field key={field.name} label={field.label} error={refused[field.name]}><Input name={field.name} type={field.type ?? 'text'} autoComplete={field.autoComplete} required /></Field>)}
        {error && <Text size="small" tone="stop">{error}</Text>}
        <Button variant="primary" block type="submit" disabled={busy}>{action}</Button>
        {sso && <Button block onClick={() => window.location.assign('/api/auth/oidc/start')}>Sign in with single sign-on</Button>}
      </form>
    </CenteredPanel>
  );
}

const EMAIL: FieldSpec = { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' };
const NAME: FieldSpec = { name: 'name', label: 'Your name', autoComplete: 'name' };
const NEW_PASSWORD: FieldSpec = { name: 'password', label: 'Password (12 characters or more)', type: 'password', autoComplete: 'new-password' };

export function LoginPage() {
  const oidc = useResource<{ enabled: boolean }>('/api/auth/oidc');
  return <SessionForm sso={oidc.data?.enabled === true} title="Sign in" fields={[EMAIL, { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' }]} action="Sign in" endpoint="/api/auth/login" />;
}
export const SetupPage = () => <SessionForm title="Set up your organization" note="This link works once. You become the owner." fields={[{ name: 'orgName', label: 'Organization name' }, NAME, EMAIL, NEW_PASSWORD]} action="Create organization" endpoint="/api/auth/setup" extra={{ token: new URLSearchParams(window.location.search).get('token') ?? '' }} />;
export const InvitePage = ({ token }: { token: string }) => <SessionForm title="Join the organization" fields={[NAME, NEW_PASSWORD]} action="Join" endpoint={`/api/auth/invites/${token}`} />;
