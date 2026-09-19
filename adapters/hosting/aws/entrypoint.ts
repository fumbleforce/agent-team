import { execFileSync } from 'node:child_process';
import { startControlPlane } from '../shared/controlPlane.ts';

// Secrets live in Parameter Store under the deployment's prefix; control-plane secrets win over shared ones.
function loadSecrets(prefix: string, region: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const path of [prefix, `${prefix}/control`]) {
    const output = execFileSync('aws', ['ssm', 'get-parameters-by-path', '--path', path, '--with-decryption', '--region', region, '--query', 'Parameters[].[Name,Value]', '--output', 'json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    for (const [name, value] of JSON.parse(output) as [string, string][]) secrets[name.slice(name.lastIndexOf('/') + 1)] = value;
  }
  return secrets;
}

const prefix = process.env.AGENT_TEAM_SSM_PREFIX, region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
if (!prefix || !region) throw new Error('AGENT_TEAM_SSM_PREFIX and AWS_REGION are required');
Object.assign(process.env, loadSecrets(prefix, region));
// The instance is reached through a Session Manager tunnel, so the address an owner sees is local.
await startControlPlane({ publicUrl: process.env.AGENT_TEAM_PUBLIC_URL ?? 'http://127.0.0.1:4310' });
