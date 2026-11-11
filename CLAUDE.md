# Tendril

Farming game played by writing Lua. Scripts run on the player's machine; the server only replays
the action log through the same rules, so client hacks are pointless. Plan and rationale:
https://claude.ai/artifact/CGSQSFnjdxSSPiNHN4JsTp

## Stack
pnpm workspace, TypeScript everywhere. `packages/sim` = deterministic rules + Lua runner (wasmoon).
Planned: `packages/client` (Electron + Vite + Monaco + Three.js), `packages/server` (Supabase SQL + verifier), `assets/` (Blender scripts, .glb).

## Commands
- `pnpm test` / `pnpm typecheck` at the root run every package.
- `pnpm --filter @tendril/sim test`

## Rules that must not be broken
- `packages/sim/src` rule code is integers only. No floats, `Math.random`, `Date`, I/O. See `docs/SIM_SPEC.md`.
- Any change to rule behaviour bumps `RULES_VERSION` and regenerates golden hashes.
- The server never imports `lua.ts` and never runs player code.
- `docs/SIM_SPEC.md` is the source of truth; change the spec first, then the code.
