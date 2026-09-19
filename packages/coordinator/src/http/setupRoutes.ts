import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, type Context } from '../context.ts';
import { CATALOG, customCredentialVariable, setupEntry, type SetupEntry, type Values } from '../../../../adapters/integration/catalog.ts';
import type { Integrations } from '../repos/integrations.ts';

const SetupBody = z.object({ kind: z.string().max(40), values: z.record(z.string().max(40), z.string().max(400)).default({}) });
type Project = { id: string; slug: string };
interface Deps { context: Context; integrations: Integrations; env?: NodeJS.ProcessEnv; fetch?: typeof fetch;
  projectFor(c: unknown, action: 'project.read' | 'project.configure'): Promise<{ project: Project }>; body<T>(c: unknown, schema: z.ZodType<T>): Promise<T>; userId(c: unknown): string }

// Guided setup of what a project connects to. The catalog's words and checks come from the adapters; this file only
// validates what was entered, checks that the credential is present where it must be, and stores the result.
export function mountSetupRoutes(app: Hono<any>, deps: Deps) {
  const { context, integrations } = deps, env = deps.env ?? process.env, request = deps.fetch ?? fetch;
  const variableOf = (entry: SetupEntry, values: Values) => entry.credential?.variable ?? (entry.kind === 'mcp' && values.name ? customCredentialVariable(values.name) : null);
  // A variable set on purpose, or whatever else the product's adapter can find on this machine (an existing login).
  const credentialOf = (entry: SetupEntry): { token: string; source: string } | null => {
    const named = [entry.credential?.variable, ...(entry.credential?.alternatives ?? [])].map(name => (name ? env[name] : undefined)).find(Boolean);
    return named ? { token: named, source: 'a variable on this machine' } : entry.findCredential?.(env) ?? null;
  };
  const tokenOf = (entry: SetupEntry) => credentialOf(entry)?.token ?? null;

  function checked(input: z.infer<typeof SetupBody>): { entry: SetupEntry; values: Values } {
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
    return { entry, values };
  }

  // What the app is told about an entry: never its functions, and for a credential only whether one was found and where.
  const described = (entry: SetupEntry) => {
    const { test, findCredential: _find, ...rest } = entry;
    const here = rest.credential?.runsOn === 'coordinator', found = here ? credentialOf(entry) : null;
    return { ...rest, testable: Boolean(test) && here, credentialPresent: here ? found !== null : null, credentialSource: found?.source ?? null, prefill: {} as Values };
  };
  app.get('/api/integrations/catalog', c => c.json({ entries: CATALOG.map(described) }));
  // The same catalog for one project: what was already entered for another entry of the same product is offered again.
  app.get('/api/projects/:slug/integrations/catalog', async c => {
    const { project } = await deps.projectFor(c, 'project.read');
    const connections = await integrations.connections(project.id);
    // The repository is known from the connection made in the app, or from the manifest a checkout registered with `up`.
    const row = await context.storage.db.selectFrom('projects').select('manifest').where('id', '=', project.id).executeTakeFirst();
    const manifest = row ? JSON.parse(row.manifest) as { scm?: { kind?: string }; delivery?: { repository?: string; baseBranch?: string } } : {};
    return c.json({ entries: CATALOG.map(entry => {
      const shared = entry.sharesWith ? connections.find(item => item.kind === entry.sharesWith) : undefined;
      const registered: Record<string, unknown> = entry.sharesWith && manifest.scm?.kind === entry.sharesWith ? { repository: manifest.delivery?.repository, baseBranch: manifest.delivery?.baseBranch } : {};
      const prefill = Object.fromEntries(entry.fields.flatMap(field => { const value = shared?.config[field.key] ?? registered[field.key]; return typeof value === 'string' && value ? [[field.key, value]] : []; }));
      return { ...described(entry), prefill };
    }) });
  });

  app.post('/api/projects/:slug/integrations/test', async c => {
    await deps.projectFor(c, 'project.configure');
    const { entry, values } = checked(await deps.body(c, SetupBody));
    const token = tokenOf(entry);
    if (!entry.test) return c.json({ ok: true, message: 'Nothing to check from here: this one is used by the workers.' });
    if (!token) return c.json({ ok: false, message: `${entry.credential!.variable} is not set on the coordinator yet. Set it, restart the coordinator and test again.` });
    try { return c.json({ ok: true, message: await entry.test(values, token, request) }); }
    catch (error) { return c.json({ ok: false, message: (error as Error).message.slice(0, 300) }); }
  });

  app.post('/api/projects/:slug/integrations/setup', async c => {
    const { project } = await deps.projectFor(c, 'project.configure');
    const { entry, values } = checked(await deps.body(c, SetupBody));
    const variable = variableOf(entry, values);
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
      waiting: entry.credential?.runsOn === 'coordinator' ? (credentialOf(entry) ? `Signed in through ${credentialOf(entry)!.source}` : `Waiting for ${entry.credential.variable} on the coordinator`) : entry.credential?.runsOn === 'workers' ? `Each worker signs in with its own ${entry.credential.label}` : null,
      connected: entry.credential?.runsOn !== 'coordinator' || tokenOf(entry) !== null,
    });
    return c.json({ ok: true });
  });
}
