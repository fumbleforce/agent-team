import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

// Archives run files to s3://bucket/prefix/jobId/ with the AWS CLI. Links are console URLs by
// default, or presigned URLs when `presignSeconds` is set (they expire; the dashboard shows both).
export const NAME = 's3';

function aws(args, { env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('aws', args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`));
      resolve(String(stdout).trim());
    });
  });
}

export function create({ bucket, prefix = 'agent-team', region, presignSeconds = 0, env = process.env, run = aws } = {}) {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('s3 artifacts require a valid bucket name');
  const regionArgs = region ? ['--region', region] : [];
  return {
    kind: NAME,
    async upload({ jobId, runDir, files }) {
      const stored = []; const links = {};
      for (const name of files) {
        const source = path.join(runDir, name);
        if (!fs.existsSync(source)) continue;
        const key = `${prefix}/${jobId}/${name}`;
        await run(['s3', 'cp', source, `s3://${bucket}/${key}`, '--only-show-errors', ...regionArgs], { env });
        stored.push(name);
        links[name] = presignSeconds > 0 ? await run(['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', String(presignSeconds), ...regionArgs], { env })
          : `https://s3.console.aws.amazon.com/s3/object/${bucket}?prefix=${encodeURIComponent(key)}`;
      }
      return { kind: NAME, location: `s3://${bucket}/${prefix}/${jobId}/`, files: stored, links };
    },
  };
}
