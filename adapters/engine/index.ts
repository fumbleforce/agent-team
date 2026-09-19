import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { opencode } from './opencode.ts';
import type { EngineAdapter } from './contract.ts';
import { fake } from './fake.ts';

export type { EngineAdapter, EngineCapabilities, TurnSpec } from './contract.ts';

const ADAPTERS: Record<string, EngineAdapter> = { claude, opencode, codex, cursor, fake };
export const ENGINES = Object.keys(ADAPTERS);

export function engineAdapter(name: string): EngineAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown engine "${name}"; known: ${ENGINES.join(', ')}`);
  return adapter;
}
