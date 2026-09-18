# Team blueprints (seeds)

A blueprint directory holds the roles file, the persona prompts and the roster that seed one stored team: `roles.json` (shared agent configuration), `roster.json` (names, titles, voices), `agents/<role>.md` (one prompt per role) and optional `portraits/<role>.webp`. The coordinator imports the toolkit root as the team `default` and each directory here as a team of the same name, once; after that the dashboard's **Teams** pages own them (versions, revert, added subagents) and a project selects a team by id in its settings.

Two things stay with the files:

- **The permission ceiling.** Every role's permissions come from the committed `roles.json` of the blueprint the control plane runs with (`AGENT_TEAM_BLUEPRINT=<name>` or the toolkit root). A stored team can rename, re-voice and re-prompt roles and add subagents, and can only tighten permissions.
- **Three roles the platform addresses by name:** `team-coordinator` (drives one cycle), `team-pm` (resident product manager and owner chat partner) and `team-owner` (front desk). Their names and voices are free.

The cycle itself is still repository-shaped: a run happens in a disposable worktree of a Git repository, one tracker issue at a time, with the report file at the end. A non-coding team works in a repository that holds its documents (`research-desk` keeps notes and drafts as Markdown) and reaches external systems through the manifest's `integrations`.

| Blueprint | Roles | Purpose |
| --- | --- | --- |
| root (`default`) | pm, ux, dev, tester, reviewer, ideation | Software delivery with tracker evidence and change requests |
| `research-desk` | pm, researcher, writer, editor, ideation | Research and writing briefs with cited notes |
