# Tendril agent entry

Read `brain/README.md`, then `brain/STATUS.md`, `brain/MAP.md`, `brain/CONTRACTS.md`, and `brain/DECISIONS.md` before working. These are the maintained directory brain and takeover context; do not rediscover the whole repo.

This working copy lives here, not `~/Developer/tendril`. Never edit that original folder. Work only inside the current workspace, with exclusive ownership from the coordinator. Agents write their own `brain/notes/<workstream>.md` listing actual changed files, decisions/reasons, verification and blockers; coordinator integrates shared brain documents after reviewing actual changes.

Do not commit, merge, push, create repositories or publish without explicit user permission. The initial copied baseline was already committed; all implementation is uncommitted on dev. Even with permission, nothing reaches main before lint, typecheck, unit, build, browser E2E and Electron smoke all pass without retries.

Rules engine: `docs/SIM_SPEC.md` is authoritative. Safe integer maths; seeded streams only; no I/O or clock in rules. Changes to game behavior require spec + RULES_VERSION update. Server imports `@tendril/sim/src/index.ts`, never Lua/local.ts. The server replays actions, never player code. FNV state hashes are diagnostics, not authentication.

Coordinator owns root package manifests/lockfile/dependencies/shared configuration. Request changes in notes instead of editing files owned by other agents. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` are coordinator-maintained entry points. Backend dev authentication is local-only, not production sign-in.
