// Only REMOTE/BRANCH bases can be fetched; the fetch updates that remote-tracking ref alone.
export function remoteBase(base) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/(.+)$/.exec(String(base));
  if (!match || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(match[2]) || match[2].includes('..') || match[2].includes('@{')
    || match[2].split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock') || part.startsWith('-'))) {
    throw new Error('--fetch requires --base REMOTE/BRANCH, e.g. origin/main');
  }
  return { remote: match[1], branch: match[2], ref: `refs/remotes/${match[1]}/${match[2]}`,
    refspec: `+refs/heads/${match[2]}:refs/remotes/${match[1]}/${match[2]}` };
}
