import type { SkillFile } from '../../packages/protocol/src/skills.ts';

// Where skills are imported from: a collection of skill folders (a SKILL.md each, and files beside it) at one place of a code
// host, read at one commit. An adapter of this kind only reads; it never runs what it reads, and a script in a skill is kept
// as text. Every adapter of this kind implements this contract and passes the contract test.
export interface SkillCollection {
  source: { repository: string; path: string; commit: string | null; license: string; author: string | null; url: string };
  // Each skill with its folder in the repository.
  skills: { slug: string; path: string; description: string; body: string; files: SkillFile[] }[];
  // What was left out and why: a file too large, a folder past the limit, a SKILL.md without a description.
  skipped: string[];
}

export interface SkillSource {
  name: string;
  // How the page names it, and an address to show as an example.
  title: string;
  example: string;
  // Whether this adapter reads this address.
  matches(url: string): boolean;
  // Every skill at the address: a folder of skill folders, or one skill folder.
  read(url: string): Promise<SkillCollection>;
}

// What one import may bring in; more than this is left out and said so.
export const SKILL_LIMITS = { skills: 80, filesPerSkill: 30, fileBytes: 60_000, totalBytes: 3_000_000 } as const;
// The files a skill may carry: text a person or an agent reads. Anything else is left out.
export const SKILL_TEXT = /\.(md|txt|sh|ts|tsx|js|mjs|py|json|ya?ml|toml|html|css)$/i;

export class SkillSourceError extends Error {}
