import { SkillSourceError, type SkillCollection, type SkillSource } from './contract.ts';
import { githubSkills } from './github.ts';

export type { SkillCollection, SkillSource } from './contract.ts';
export { SKILL_LIMITS, SkillSourceError } from './contract.ts';

export interface SkillSourceOptions { env?: NodeJS.ProcessEnv; fetch?: typeof fetch }
export const skillSources = (options: SkillSourceOptions = {}): SkillSource[] => [githubSkills(options)];

// The skills at an address, from whichever adapter reads it.
export async function readSkillCollection(url: string, options: SkillSourceOptions = {}): Promise<SkillCollection> {
  const source = skillSources(options).find(item => item.matches(url));
  if (!source) throw new SkillSourceError('Skills can be imported from a GitHub address so far, like https://github.com/owner/repo/tree/main/skills');
  return source.read(url);
}
