# Shared agent-team platform

This package is reusable across projects. Keep product-specific goals, stacks, commands, Linear routing and local paths in project/worker configuration, not in shared role implementations.

Use Node built-ins and ESM. Run `npm test`, `npm run check`, and `git diff --check` after changing coordination or runner behavior. Tests use disposable repositories, synthetic processes and temporary SQLite; do not invoke paid models or real account mutations from tests.

`docs/SPEC.md` is the target architecture. New packages follow it: TypeScript only, Node 24, the dependency budget in its section 3, and the token and component rules in its section 14. The rules in this file govern the existing `core/` code until the phase that replaces it.

Retain atomic job claims, per-project serialization, lease validation, fail-stop workers and quarantine after uncertain execution. Never auto-reassign expired work. Do not treat instructions or shell permission patterns as OS isolation. Publishing and service activation require explicit authorization.
