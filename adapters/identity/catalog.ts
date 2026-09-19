// What a person sees when setting up single sign-on: one entry per identity product, with the words of that product's
// own console. The platform renders these generically, derives the sign-in address from what was copied back, and never
// names a product itself. Every entry speaks OpenID Connect; they differ in where the app is registered and what is copied.
import type { SetupField, Values } from '../integration/catalog.ts';

// The client secret never enters the app: it is set as this variable where the coordinator runs, and only its presence is checked.
export const SECRET_VARIABLE = 'AGENT_TEAM_OIDC_SECRET';
// Where the identity product sends a person back to, after this app's own address.
export const REDIRECT_PATH = '/api/auth/oidc/callback';

export interface IdentityEntry {
  kind: string; title: string; summary: string;
  // How to register this app in the product's console, in order. "The redirect address" is shown next to the steps with a copy button.
  steps: string[];
  fields: SetupField[];
  // The field an unreachable sign-in address is blamed on, or null when the address is fixed.
  addressField: string | null;
  // The sign-in service's address (the OpenID issuer), derived from what was copied back.
  issuer(values: Values): string;
  // What the check says in plain words when discovery answers, and when it does not.
  found: string; notFound: string;
}

const SECRET_STEP = (what: string) => `On the coordinator machine set ${SECRET_VARIABLE} to ${what}, then restart the coordinator. The secret is never entered in this app.`;
const CLIENT_ID: SetupField = { key: 'clientId', label: 'Client ID', required: true, pattern: '\\S{4,200}' };
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const HOST = '[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9\\-]*[a-zA-Z0-9])?)+';
const trimmed = (address: string) => address.replace(/\/+$/, '');

export const IDENTITY_CATALOG: IdentityEntry[] = [
  {
    kind: 'google-workspace', title: 'Google Workspace',
    summary: 'People sign in with their Google account from your organization.',
    steps: [
      'In the Google Cloud console pick (or create) a project that belongs to your organization, then open Google Auth Platform → Audience and set the user type to "Internal" so only your organization can sign in.',
      'Open Google Auth Platform → Clients and choose Create client.',
      'For "Application type" choose "Web application" and give it a name.',
      'Under "Authorized redirect URIs" add the redirect address shown above, then choose Create.',
      'Copy "Client ID" into the field below.',
      SECRET_STEP('the "Client secret" shown when the client is created; Google shows it only then, so copy it right away'),
    ],
    fields: [{ ...CLIENT_ID, placeholder: '1234567890-abc123.apps.googleusercontent.com', help: 'It ends with .apps.googleusercontent.com.', pattern: '[\\w\\-]+\\.apps\\.googleusercontent\\.com' }],
    addressField: null, issuer: () => 'https://accounts.google.com',
    found: 'Found Google\'s sign-in service.', notFound: 'Google\'s sign-in service did not answer. Check that the coordinator can reach the internet.',
  },
  {
    kind: 'microsoft-entra', title: 'Microsoft Entra ID',
    summary: 'People sign in with their Microsoft work account (formerly Azure AD).',
    steps: [
      'In the Microsoft Entra admin center open Entra ID → App registrations and choose New registration.',
      'Give it a name. Under "Supported account types" choose the single tenant option (only accounts in your own directory), then choose Register.',
      'On the app\'s Overview page copy "Application (client) ID" and "Directory (tenant) ID" into the fields below.',
      'Under Manage open Authentication → Add Redirect URI, select the platform "Web", paste the redirect address shown above and choose Configure.',
      'Open Token configuration → Add optional claim, choose the token type "ID", tick "email" and choose Add, so the app learns who signed in.',
      'Open Certificates & secrets → Client secrets → New client secret, choose Add and copy its "Value" (not the "Secret ID"); it is never displayed again after you leave the page.',
      SECRET_STEP('that Value'),
    ],
    fields: [
      { key: 'tenant', label: 'Directory (tenant) ID', required: true, placeholder: '72f988bf-86f1-41af-91ab-2d7cd011db47', help: 'From the app\'s Overview page.', pattern: UUID },
      { ...CLIENT_ID, label: 'Application (client) ID', placeholder: '3fa85f64-5717-4562-b3fc-2c963f66afa6', help: 'From the same Overview page.', pattern: UUID },
    ],
    addressField: 'tenant', issuer: values => `https://login.microsoftonline.com/${values.tenant!.toLowerCase()}/v2.0`,
    found: 'Found Microsoft\'s sign-in service for your tenant.', notFound: 'Microsoft has no tenant with that ID. Copy "Directory (tenant) ID" from the app\'s Overview page.',
  },
  {
    kind: 'okta', title: 'Okta',
    summary: 'People sign in through your Okta organization.',
    steps: [
      'In the Okta Admin Console open Applications → Applications and choose Create App Integration.',
      'For "Sign-in method" choose "OIDC - OpenID Connect", for "Application type" choose "Web Application", then Next.',
      'Under "Sign-in redirect URIs" enter the redirect address shown above, replacing any example that is already there.',
      'Under "Assignments" choose who may use the app ("Controlled access"), then Save.',
      'On the General tab, under "Client Credentials", copy "Client ID" into the field below. Your Okta domain is in the menu under your username at the top right of the Admin Console.',
      SECRET_STEP('the "Client secret" from the same "Client Credentials" section'),
    ],
    fields: [
      { key: 'domain', label: 'Okta domain', required: true, placeholder: 'acme.okta.com', help: 'Without https:// and without "-admin".', pattern: HOST },
      { ...CLIENT_ID, placeholder: '0oa1b2c3d4E5f6G7h8i9' },
    ],
    addressField: 'domain', issuer: values => `https://${values.domain!.toLowerCase()}`,
    found: 'Found Okta\'s sign-in service for your organization.', notFound: 'No Okta organization answers at that domain. Use the domain without "-admin", for example acme.okta.com.',
  },
  {
    kind: 'auth0', title: 'Auth0',
    summary: 'People sign in through your Auth0 tenant and whatever it is connected to.',
    steps: [
      'In the Auth0 Dashboard open Applications → Applications and choose Create Application.',
      'Give it a name, choose "Regular Web Applications", then Create.',
      'On the Settings tab, under "Application URIs", paste the redirect address shown above into "Allowed Callback URLs" and save the changes.',
      'From "Basic Information" on the same tab copy "Domain" and "Client ID" into the fields below.',
      SECRET_STEP('the "Client Secret" from the same "Basic Information" section'),
    ],
    fields: [
      { key: 'domain', label: 'Domain', required: true, placeholder: 'acme.eu.auth0.com', help: 'Exactly as the Settings tab shows it, without https://.', pattern: HOST },
      { ...CLIENT_ID, placeholder: 'aBcD1234eFgH5678iJkL9012mNoP3456' },
    ],
    // This product's issuer ends with a slash.
    addressField: 'domain', issuer: values => `https://${values.domain!.toLowerCase()}/`,
    found: 'Found Auth0\'s sign-in service for your tenant.', notFound: 'No Auth0 tenant answers at that domain. Copy "Domain" from the application\'s Settings tab.',
  },
  {
    kind: 'keycloak', title: 'Keycloak',
    summary: 'People sign in through a realm of your own Keycloak server.',
    steps: [
      'In the Keycloak admin console pick the realm your people are in, open Clients and choose Create client.',
      'Keep "Client type" as "OpenID Connect", give it a Client ID such as "agent-team", then Next.',
      'Turn "Client authentication" on and keep "Standard flow" ticked, then Next.',
      'Under "Valid redirect URIs" paste the redirect address shown above, then Save.',
      'Enter the server\'s address, the realm\'s name and the Client ID you chose in the fields below.',
      SECRET_STEP('the "Client secret" from the client\'s Credentials tab'),
    ],
    fields: [
      { key: 'server', label: 'Keycloak address', required: true, placeholder: 'https://id.example.com', help: 'Where you open Keycloak, without /admin or /realms.', pattern: 'https?://[^\\s/]+(/[^\\s]*)?' },
      { key: 'realm', label: 'Realm', required: true, placeholder: 'company', help: 'The realm\'s name as the address bar shows it, not its display name.', pattern: '[\\w.\\-]{1,80}' },
      { ...CLIENT_ID, placeholder: 'agent-team' },
    ],
    addressField: 'server', issuer: values => `${trimmed(values.server!)}/realms/${values.realm}`,
    found: 'Found the sign-in service of that realm.', notFound: 'No realm answers there. Check the server\'s address and the realm\'s name as the address bar shows it.',
  },
  {
    kind: 'oidc', title: 'Another OpenID Connect provider',
    summary: 'Any identity product that speaks OpenID Connect with discovery.',
    steps: [
      'In your identity product register a new application of the type "Web" (sometimes called "confidential" or "server-side") that signs in with OpenID Connect and the authorization code flow.',
      'Where it asks for a redirect or callback address, paste the redirect address shown above.',
      'Allow the scopes openid, email and profile.',
      'Copy the issuer address and the client ID into the fields below.',
      SECRET_STEP('the client secret it gives you'),
    ],
    fields: [
      { key: 'issuer', label: 'Issuer address', required: true, placeholder: 'https://id.example.com', help: 'The product\'s documentation calls it "issuer" or "discovery address"; leave out /.well-known/openid-configuration.', pattern: 'https?://[^\\s/]+(/[^\\s]*)?' },
      CLIENT_ID,
    ],
    addressField: 'issuer', issuer: values => values.issuer!.replace(/\/\.well-known\/openid-configuration$/, ''),
    found: 'Found a sign-in service at that address.', notFound: 'That address does not answer as a sign-in service.',
  },
];

export const identityEntry = (kind: string): IdentityEntry | null => IDENTITY_CATALOG.find(entry => entry.kind === kind) ?? null;
