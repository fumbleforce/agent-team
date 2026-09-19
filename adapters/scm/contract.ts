import type { ScmGate } from '../../packages/worker/src/deliver/gate.ts';
import type { Exec } from './publish.ts';
import type { ScmApi, ScmApiOptions } from './api.ts';

// What one SCM host provides besides publishing (publish.ts): the merge gate's view, checks and
// merge (gates.ts), plus the naming, validation and link helpers the rest of the platform shows.
export interface ScmProvider {
  name: string; cli: string; tokenVariable: string;
  changeNoun: string; changeAbbreviation: string;
  gate: ScmGate;
  // Shell prefixes engines must never run; the worker's delivery gate is the only merge path.
  mergeDenials: readonly string[];
  host(env?: Record<string, string | undefined>): string;
  validateRepository(repository: unknown): boolean;
  isChangeUrl(url: string): boolean;
  linkText(url: string): string;
  commitUrl(repository: string, sha: string, env?: Record<string, string | undefined>): string;
  // Rejects when the CLI holds no usable login.
  auth(exec: Exec, cwd: string): Promise<string>;
  // What the coordinator polls over HTTP: review state, test reports and environments. Null without the host's token.
  api(options?: ScmApiOptions): ScmApi | null;
}
