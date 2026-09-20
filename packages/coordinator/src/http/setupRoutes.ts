import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, type Context } from '../context.ts';
import { CATALOG, customCredentialVariable, setupEntry, type SetupEntry, type Values } from '../../../../adapters/integration/catalog.ts';
import type { Integrations } from '../repos/integrations.ts';

const SetupBody = z.object({ kind: z.string().max(40), token: z.string().trim().max(4000).optional(), values: z.record(z.string().max(40), z.string().max(400)).default({}) });
type Project = { id: string; slug: string };
interface Deps { context: Context; integrations: Integrations; env?: NodeJS.ProcessEnv; fetch?: typeof fetch;
  projectFor(c: unknown, action: 'project.read' | 'project.configure'): Promise<{ project: Project }>; body<T>(c: unknown, schema: z.ZodType<T>): Promise<T>; userId(c: unknown): string }

// Guided setup of what a project connects to. The catalog's words and checks come from the adapters; this file only
// validates what was entered, keeps a token typed here sealed, and stores the result.
export function mountSetupRoutes(app: Hono<any>, deps: Deps) {
  const { context, integrations } = deps, env = deps.env ?? context.env, request = deps.fetch ?? context.fetch;
  const variableOf = (entry: SetupEntry, values: Values) => entry.credential?.variable ?? (entry.kind === 'mcp' && values.name ? customCredentialVariable(values.name) : null);
  // A variable set on purpose, or whatever else the product's adapter can find on this machine (an existing login).
  const credentialOf = (entry: SetupEntry): { token: string; source: string } | null => {
    const named = [entry.credential?.variable, ...(entry.credential?.alternatives ?? [])].map(name => (name ? env[name] : undefined)).find(Boolean);
    const saved = [entry.credential?.variable, ...(entry.credential?.alternatives ?? [])].some(name => name && context.secrets.has(name));
    return named ? { token: named, source: saved ? 'saved here' : 'a variable on this machine' } : entry.findCredential?.(env) ?? null;
  };
  const signedIn = (entry: SetupEntry, found: { source: string }) => (found.source === 'saved here' ? `${entry.credential!.label} saved` : `Signed in through ${found.source}`);
  const tokenOf = (entry: SetupEntry) => credentialOf(entry)?.token ?? null;
  // A token typed into the form, for an entry whose credential the coordinator uses.
  const typed = (entry: SetupEntry, token: string | undefined): string | null => {
    if (!token || entry.credential?.runsOn !== 'coordinator') return null;
    if (/\s/.test(token) || token.length < 8) throw new HttpError(400, 'invalid', 'Some fields need another look', { token: `That does not look like a ${entry.credential.label}` });
    return token;
  };

  function checked(input: z.infer<typeof SetupBody>): { entry: SetupEntry; values: Values; token: string | null } {
    const entry = setupEntry(input.kind);
    if (!entry) throw new HttpError(404, 'not_found', 'That integration is not supported');
    const values: Values = {}, fields: Record<string, string> = {};
    for (const field of entry.fields) {
      const value = (input.values[field.key] ?? '').trim();
      if (!value) { if (field.required) fields[field.key] = `${field.label} is needed`; continue; }
      if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) { fields[field.key] = `${field.label} does not look right${field.placeholder ? `; it should look like ${field.placeholder}` : ''}`; continue; }
      values[field.key] = value;
    }
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'Some fields need another look', fields);
    return { entry, values, token: typed(entry, input.token) };
  }

  // What the app is told about an entry: never its functions, and for a credential only whether one was found and where.
  const described = (entry: SetupEntry) => {
    const { test, findCredential: _find, fields, ...rest } = entry;
    const here = rest.credential?.runsOn === 'coordinator', found = here ? credentialOf(entry) : null;
    return { ...rest, fields: fields.map(({ choices, ...field }) => ({ ...field, pickable: Boolean(choices) && here })), testable: Boolean(test) && here, credentialPresent: here ? found !== null : null, credentialSource: found?.source ?? null, prefill: {} as Values };
  };
  app.get('/api/integrations/catalog', c => c.json({ entries: CATALOG.map(described) }));
  // The same catalog for one project: what was already entered for another entry of the same product is offered again.
  app.get('/api/projects/:slug/integrations/catalog', async c => {
    const { project } = await deps.projectFor(c, 'project.read');
    const connections = await integrations.connections(project.id);
    // What is known about a product comes from every connection of that product and from the project's own manifest
    // (what a checkout registered with `up`, or what another entry of the product wrote there). The newest connection wins.
    const row = await context.storage.db.selectFrom('projects').select('manifest').where('id', '=', project.id).executeTakeFirst();
    const manifest = row ? JSON.parse(row.manifest) as { scm?: { kind?: string }; delivery?: { repository?: string; baseBranch?: string }; tracker?: Record<string, unknown> & { kind?: string } } : {};
    const productOf = (kind: string | undefined, target: SetupEntry['target']) => CATALOG.find(item => item.target === target && (item.adapterKind ?? item.kind) === kind)?.product;
    const known = (product: string): Record<string, unknown> => ({
      ...(productOf(manifest.tracker?.kind, 'tracker') === product ? manifest.tracker : {}),
      ...(productOf(manifest.scm?.kind, 'scm') === product ? { repository: manifest.delivery?.repository, baseBranch: manifest.delivery?.baseBranch } : {}),
      ...Object.assign({}, ...connections.filter(item => setupEntry(item.kind)?.product === product).map(item => item.config)),
    });
    return c.json({ entries: CATALOG.map(entry => {
      const pool = entry.product ? known(entry.product) : {};
      const prefill = Object.fromEntries(entry.fields.flatMap(field => { const value = pool[field.key]; return typeof value === 'string' && value ? [[field.key, value]] : []; }));
      return { ...described(entry), prefill };
    }) });
  });

  // What a field can be picked from, asked of the product itself with the token that was pasted or saved.
  app.post('/api/projects/:slug/integrations/choices', async c => {
    await deps.projectFor(c, 'project.configure');
    const input = await deps.body(c, z.object({ kind: z.string().max(40), field: z.string().max(40), token: z.string().trim().max(4000).optional() }));
    const entry = setupEntry(input.kind), field = entry?.fields.find(item => item.key === input.field);
    if (!entry || !field?.choices) throw new HttpError(404, 'not_found', 'There is no list for that');
    const token = typed(entry, input.token) ?? tokenOf(entry);
    if (!token) return c.json({ choices: [], message: `Paste the ${entry.credential!.label} first.` });
    try { return c.json({ choices: (await field.choices(token, request)).slice(0, 500), message: null }); }
    catch (error) { return c.json({ choices: [], message: (error as Error).message.slice(0, 300) }); }
  });

  app.post('/api/projects/:slug/integrations/test', async c => {
    await deps.projectFor(c, 'project.configure');
    const { entry, values, token: given } = checked(await deps.body(c, SetupBody));
    const token = given ?? tokenOf(entry);
    if (!entry.test) return c.json({ ok: true, message: 'Nothing to check from here.' });
    if (!token) return c.json({ ok: false, message: `Paste the ${entry.credential!.label} first.` });
    try { return c.json({ ok: true, message: await entry.test(values, token, request) }); }
    catch (error) { return c.json({ ok: false, message: (error as Error).message.slice(0, 300) }); }
  });

  app.post('/api/projects/:slug/integrations/setup', async c => {
    const { project } = await deps.projectFor(c, 'project.configure');
    const { entry, values, token } = checked(await deps.body(c, SetupBody));
    const variable = variableOf(entry, values);
    if (token) await context.secrets.set(entry.credential!.variable, token, deps.userId(c));
    if (entry.target !== 'connection') {
      // The tracker and the code host are part of the project's manifest, which is what polling and delivery read.
      const row = await context.storage.db.selectFrom('projects').select('manifest').where('id', '=', project.id).executeTakeFirstOrThrow();
      const manifest = JSON.parse(row.manifest) as { tracker?: unknown; scm?: unknown; delivery?: Record<string, unknown> };
      const kind = entry.adapterKind ?? entry.kind;
      if (entry.target === 'tracker') manifest.tracker = { kind, ...values };
      else { manifest.scm = { kind }; manifest.delivery = { requiredChecks: [], autoMergeAuthorized: false, ...manifest.delivery, repository: values.repository, baseBranch: values.baseBranch ?? 'main' }; }
      await context.storage.db.updateTable('projects').set({ manifest: JSON.stringify(manifest) }).where('id', '=', project.id).execute();
    }
    await integrations.replace(deps.userId(c), project.id, entry.target === 'connection' ? null : entry.target, {
      kind: entry.kind === 'mcp' ? 'mcp' : entry.kind, name: entry.kind === 'mcp' ? values.name! : entry.title, category: entry.category, mode: entry.mode, credentialRef: variable, config: { ...values, target: entry.target },
      // What the card says under the name: where the sign-in comes from, or what is still missing, in words.
      waiting: entry.credential?.runsOn === 'coordinator' ? (credentialOf(entry) ? signedIn(entry, credentialOf(entry)!) : `Needs a ${entry.credential.label}`) : entry.credential?.runsOn === 'workers' ? 'Uses the sign-in on each worker' : null,
      connected: entry.credential?.runsOn !== 'coordinator' || tokenOf(entry) !== null,
    });
    return c.json({ ok: true });
  });

  // A project registered from a checkout names its code host and tracker in its manifest. They are shown as connections too,
  // so the app tells the same story whichever way the project was set up. Nothing a person connected by hand is replaced.
  async function adoptManifest(projectId: string, by: string | null) {
    const row = await context.storage.db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirst();
    const manifest = row ? JSON.parse(row.manifest) as { scm?: { kind?: string }; delivery?: { repository?: string; baseBranch?: string }; tracker?: Record<string, unknown> & { kind?: string } } : {};
    const existing = await integrations.connections(projectId);
    const has = (target: string) => existing.some(item => item.projectScoped && item.config.target === target);
    const adopt = async (entry: SetupEntry | undefined, values: Values) => {
      if (!entry || has(entry.target)) return;
      const found = entry.credential?.runsOn === 'coordinator' ? credentialOf(entry) : null;
      await integrations.replace(by, projectId, entry.target, { kind: entry.kind, name: entry.title, category: entry.category, mode: entry.mode, credentialRef: entry.credential?.variable ?? null, config: { ...values, target: entry.target },
        waiting: entry.credential?.runsOn === 'coordinator' ? (found ? signedIn(entry, found) : `Needs a ${entry.credential.label}`) : entry.credential ? 'Uses the sign-in on each worker' : null,
        connected: entry.credential?.runsOn !== 'coordinator' || found !== null });
    };
    const strings = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && pair[0] !== 'kind'));
    if (manifest.scm?.kind && manifest.delivery?.repository) await adopt(CATALOG.find(item => item.target === 'scm' && (item.adapterKind ?? item.kind) === manifest.scm!.kind), strings({ repository: manifest.delivery.repository, baseBranch: manifest.delivery.baseBranch }));
    if (manifest.tracker?.kind) await adopt(CATALOG.find(item => item.target === 'tracker' && (item.adapterKind ?? item.kind) === manifest.tracker!.kind), strings(manifest.tracker));
  }
  return { adoptManifest };
}
