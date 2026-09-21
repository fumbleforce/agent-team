import { execFileSync } from 'node:child_process';
import os from 'node:os';
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
// What the deploy recorded for starting workers (network, image, instance profile), base64 so it survives an environment file.
const launcher = process.env.AGENT_TEAM_LAUNCHER_B64 ? JSON.parse(Buffer.from(process.env.AGENT_TEAM_LAUNCHER_B64, 'base64').toString('utf8')) as Record<string, unknown> : null;
// Workers reach the control plane inside its network, on the host's own address.
const address = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address;
const internalUrl = process.env.AGENT_TEAM_INTERNAL_URL ?? (address ? `http://${address}:${process.env.PORT ?? 4310}` : undefined);
// The instance is reached through a Session Manager tunnel, so the address an owner sees is local.
await startControlPlane({ publicUrl: process.env.AGENT_TEAM_PUBLIC_URL ?? 'http://127.0.0.1:4310', launcher, ...(internalUrl ? { internalUrl } : {}) });
