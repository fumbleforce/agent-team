import * as fs from 'node:fs';
import path from 'node:path';
import type { ArtifactStore } from './contract.ts';

// Run directories stay on the worker's disk; the "upload" copies them under a stable root and
// links point at that directory. This is the behaviour for persistent workers.
export const NAME = 'local';
export interface LocalOptions { root?: string }

export function create({ root = '.agent-team-artifacts' }: LocalOptions = {}): ArtifactStore {
  return {
    kind: NAME,
    async upload({ jobId, runDir, files }) {
      const target = path.join(path.resolve(root), jobId);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const stored: string[] = [];
      for (const name of files) {
        const source = path.join(runDir, name);
        if (!fs.existsSync(source)) continue;
        fs.copyFileSync(source, path.join(target, name));
        stored.push(name);
      }
      return { kind: NAME, location: target, files: stored, links: Object.fromEntries(stored.map(name => [name, `file://${path.join(target, name)}`])) };
    },
  };
}
