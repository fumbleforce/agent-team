import * as github from './github.mjs';
import * as gitlab from './gitlab.mjs';

const ADAPTERS = { github, gitlab };
export const SCM_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_SCM = 'github';

export function scmAdapter(kind = DEFAULT_SCM) {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`Unknown scm kind: ${kind}. Use ${SCM_KINDS.join(', ')}`);
  return ADAPTERS[kind];
}

// Link text for any known provider URL, for dashboards that show runs from several projects.
export function linkText(url) {
  const adapter = Object.values(ADAPTERS).find(candidate => candidate.isChangeUrl(url));
  return adapter ? adapter.linkText(url) : String(url).replace(/^https:\/\//, '');
}
