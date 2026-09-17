import * as opencode from './opencode.mjs';
import * as claude from './claude.mjs';
import * as cursor from './cursor.mjs';
import * as codex from './codex.mjs';

// Every engine adapter exports the same surface; see core/adapters.md. The core never
// branches on an engine name: it asks the adapter.
const ADAPTERS = { opencode, claude, cursor, codex };
export const ENGINES = Object.keys(ADAPTERS);
export const DEFAULT_ENGINE = 'opencode';

export function validateEngine(engine = DEFAULT_ENGINE) {
  if (!Object.hasOwn(ADAPTERS, engine)) throw new Error(`Unknown engine: ${engine}. Use ${ENGINES.join(', ')}`);
  return engine;
}

export function engineAdapter(engine = DEFAULT_ENGINE) {
  return ADAPTERS[validateEngine(engine)];
}

// Billing modes are validated per engine: an adapter that bills only one way accepts only that.
export function validateBilling(engine, billing) {
  const adapter = engineAdapter(engine);
  const mode = billing ?? adapter.DEFAULT_BILLING;
  if (!adapter.BILLING_MODES.includes(mode)) throw new Error(`Engine ${engine} does not support billing mode ${billing}. Use ${adapter.BILLING_MODES.join(', ')}`);
  return mode;
}

// Dispatch a parsed stream event to the adapter that recognizes it. Event formats do not
// overlap between engines, so the first adapter that handles a line wins.
export function parseEventLine(event, context) {
  for (const adapter of Object.values(ADAPTERS)) if (adapter.parseEvent(event, context)) return true;
  return false;
}
