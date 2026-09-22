import { spawnSync } from 'node:child_process';

// Where the token for GitHub comes from on this machine: a variable set on purpose, or else the GitHub command-line tool's
// own login, so someone who already ran `gh auth login` has nothing more to set up. Looked up once and remembered.
let cliLogin: string | null | undefined;
// `names` are the variables looked at, in order; the tracker's own token comes first by default, the code host asks for GH_TOKEN only.
export function githubCredential(env: NodeJS.ProcessEnv = process.env, options: { cli?: boolean; names?: readonly string[] } = {}): { token: string; source: 'variable' | 'cli' } | null {
  const named = (options.names ?? ['GITHUB_ISSUES_TOKEN', 'GH_TOKEN']).map(name => env[name]).find(Boolean);
  if (named?.trim() && !/\s/.test(named)) return { token: named, source: 'variable' };
  // Only the real process environment stands for "this machine"; a test's own environment never reaches for the login.
  // AGENT_TEAM_NO_CLI_LOGIN=1 turns the lookup off, for a deployment that must use only what it was given, and for tests.
  if (options.cli === false || env !== process.env || env.AGENT_TEAM_NO_CLI_LOGIN === '1') return null;
  if (cliLogin === undefined) {
    const found = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const token = found.status === 0 ? found.stdout.trim() : '';
    cliLogin = token && !/\s/.test(token) ? token : null;
  }
  return cliLogin ? { token: cliLogin, source: 'cli' } : null;
}
