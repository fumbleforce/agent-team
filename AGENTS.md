# Shared agent-team platform

This package is reusable across projects. Keep product-specific goals, stacks, commands, Linear routing and local paths in project/worker configuration, not in shared role implementations.

Use Node built-ins and ESM. Run `npm test`, `npm run check`, and `git diff --check` after changing coordination or runner behavior. Tests use disposable repositories, synthetic processes and temporary SQLite; do not invoke paid models or real account mutations from tests.

Retain atomic job claims, per-project serialization, lease validation, fail-stop workers and quarantine after uncertain execution. Never auto-reassign expired work. Do not treat instructions or shell permission patterns as OS isolation. Publishing and service activation require explicit authorization.
