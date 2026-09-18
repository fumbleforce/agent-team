# Team blueprints

A blueprint is the set of personas one control plane runs with: `roles.json` (shared agent configuration), `roster.json` (names, titles, voices), `agents/<role>.md` (one prompt per role) and optional `portraits/<role>.webp`. Select one with `AGENT_TEAM_BLUEPRINT=<name>` (a directory here) or an absolute path; unset, the toolkit's own delivery team at the repository root is the blueprint.

Every blueprint keeps three primary roles the platform addresses by name: `team-coordinator` (drives one cycle), `team-pm` (the resident product manager and owner chat partner) and `team-owner` (front desk). Subagent roles are free: the manifest's `team.roles` chooses among the blueprint's subagents, and `team.defaultRoles` in `roles.json` sets the default selection. Delivery approvals (`tester`, `reviewer`, `pm`) apply only when the blueprint declares roles with those names.

The cycle itself is still repository-shaped: a run happens in a disposable worktree of a Git repository, one tracker issue at a time, with the report file at the end. A non-coding team works in a repository that holds its documents (`research-desk` keeps notes and drafts as Markdown) and reaches external systems through the manifest's `integrations`.

| Blueprint | Roles | Purpose |
| --- | --- | --- |
| root (default) | pm, ux, dev, tester, reviewer, ideation | Software delivery with tracker evidence and change requests |
| `research-desk` | pm, researcher, writer, editor, ideation | Research and writing briefs with cited notes |
