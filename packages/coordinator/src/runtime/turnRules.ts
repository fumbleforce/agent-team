import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';

// What each kind of turn is told, kept as text in `blueprints/turns` so a change to it is read and reviewed as words, not as a
// string in the code. A team may still write its own in its way of working; these are what stands where it has not.
const FOLDER = path.join(packageRoot(), 'blueprints', 'turns');
export const rule = (name: string): string => readFileSync(path.join(FOLDER, `${name}.md`), 'utf8').trim();
