# Shared agent-team platform

This package is reusable across projects. Keep product-specific goals, stacks, commands, tracker routing and local paths in project and worker configuration, not in the platform.

`docs/SPEC.md` is the architecture. TypeScript only, on Node 24, run directly by Node: erasable syntax only, `import type` where needed, relative imports with `.ts` extensions. No `.mjs` or `.js` sources. Types are inferred from the Zod schemas in `packages/protocol`; do not hand-write a duplicate interface. A new runtime dependency needs the owner's approval (the budget is in section 3 of the spec).

Run `npm test`, `npm run check` and `git diff --check` after changing anything. Tests use disposable repositories, synthetic processes and temporary or in-memory databases; do not invoke paid models or mutate real accounts from tests.

Storage goes through the adapter in `adapters/storage`: portable Kysely queries in the packages, raw SQL only inside the adapter (`scripts/lint-sql.ts`). Inside `storage.transaction` always query through the transaction handle; the SQLite adapter has one connection and using `db` there deadlocks. Every state change appends its events in the same transaction.

Provider names belong under `adapters/` only (`scripts/lint-neutral.ts`). Adapters of one kind share a `contract.ts` and pass one contract test.

The web app is layered `ui/` → `patterns/` → `features/`. Typography, colour and radius classes appear only in `ui/` and `patterns/`; features compose them and use layout utilities only. No arbitrary-value classes, no inline styles, no hex colours outside `tokens.css` (`scripts/lint-ui.ts`). Add a variant to a primitive before styling a one-off.

Retain atomic claims, single writer per worktree, one delivery per project, lease validation on every worker and tool call, fail-stop workers and scoped quarantine after uncertain execution. Never auto-retry or auto-reassign uncertain work. Do not treat instructions or permission patterns as OS isolation. Publishing, merging and service activation require explicit authorization in the committed manifest.
