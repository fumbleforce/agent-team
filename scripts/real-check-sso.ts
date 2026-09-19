// Read-only: the sign-in addresses the guided setup derives answer as real OpenID services, and what they return names the same issuer.
// Needs no credentials. Microsoft's own public tenant id is used for the tenant-based address.
import { identityEntry } from '../adapters/identity/catalog.ts';

const CASES: [string, Record<string, string>][] = [['google-workspace', {}], ['microsoft-entra', { tenant: '72f988bf-86f1-41af-91ab-2d7cd011db47' }]];
for (const [kind, values] of CASES) {
  const issuer = identityEntry(kind)!.issuer(values);
  const response = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(8000) }).catch(() => null);
  const document = response?.ok ? await response.json() as { issuer?: string; authorization_endpoint?: string } : null;
  console.log(`${document?.issuer === issuer && document.authorization_endpoint ? 'ok  ' : 'FAIL'}  ${kind}: derived ${issuer}; the service calls itself ${document?.issuer ?? 'nothing (no answer)'}`);
  if (document?.issuer !== issuer) process.exitCode = 1;
}
