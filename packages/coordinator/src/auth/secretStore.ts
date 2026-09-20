import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StorageAdapter } from '@agent-team/storage';

// Keys and tokens entered in the app. Each is sealed before it is stored and opened only in this process; the key that opens
// them comes from AGENT_TEAM_SECRET_KEY or else from a private file next to the database, so a copy of the database alone opens nothing.
// An opened value is placed in `env` under its name, which is where every adapter already looks, so saving a key takes effect at once.
export interface SecretStore {
  load(): Promise<void>;
  has(name: string): boolean;
  get(name: string): string | null;
  set(name: string, value: string, userId: string | null): Promise<void>;
  remove(name: string): Promise<void>;
}

const NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export function createSecretStore(options: { storage: StorageAdapter; dataDir: string; env: NodeJS.ProcessEnv; now: () => number }): SecretStore {
  const { storage, env, now } = options, held = new Map<string, string>();
  let key: Buffer | null = null;
  const sealingKey = (): Buffer => {
    if (key) return key;
    if (env.AGENT_TEAM_SECRET_KEY) return (key = createHash('sha256').update(env.AGENT_TEAM_SECRET_KEY).digest());
    const file = path.join(options.dataDir, 'secret.key');
    if (!existsSync(file)) { mkdirSync(options.dataDir, { recursive: true }); writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); }
    return (key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  };
  const seal = (value: string): string => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
    return [iv, Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]), cipher.getAuthTag()].map(part => part.toString('base64')).join('.');
  };
  const open = (sealed: string): string => {
    const [iv, body, tag] = sealed.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8');
  };

  return {
    async load() {
      for (const row of await storage.db.selectFrom('secrets').select(['name', 'sealed']).execute()) {
        // A value sealed with another key cannot be opened; it is left alone and simply counts as not entered.
        try { const value = open(row.sealed); held.set(row.name, value); env[row.name] = value; } catch { console.error(`The saved ${row.name} could not be opened with this machine's key; enter it again in the app.`); }
      }
    },
    has: name => held.has(name),
    get: name => held.get(name) ?? null,
    async set(name, value, userId) {
      if (!NAME.test(name)) throw new Error(`"${name}" is not a name a key can be stored under`);
      const row = { sealed: seal(value), updated_by: userId, updated_at: now() };
      await storage.db.insertInto('secrets').values({ name, ...row }).onConflict(oc => oc.column('name').doUpdateSet(row)).execute();
      held.set(name, value); env[name] = value;
    },
    async remove(name) {
      await storage.db.deleteFrom('secrets').where('name', '=', name).execute();
      if (held.delete(name)) delete env[name];
    },
  };
}
