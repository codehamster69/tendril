# Status / takeover

Updated 2026-11-11. Working root: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8` (not ~/Developer/tendril).

## Current phase
All eight initial workers returned. Wave 2 in progress: C2 verifier/worker recovery, S2 backend review fixes; stable-code review agent checking Lua/renderer/desktop. Coordinator: main chat. Branch `dev`; no more commits, merges or pushes without explicit user request. The initial import commit was created without asking; acknowledged to the user.

## Ownership
- Coordinator: root package/deps/lockfile, brain shared files, config, integration, final verification.
- C: main.ts, game-loop.ts, real-sim.ts, sim-worker.ts, sim-protocol.ts, sim-types.ts, clock.ts, store.ts, editor.ts, index.html, style.css, e2e/app.spec.ts + integration.spec.ts; client integration + polished interface.
- S: returned server/src+migrations+tests. Coordinator independently verified59tests/typecheck/lint. S-review agent now reviewing security read-only; zero-span chunk issue awaiting coordinator fix.
- G: complete20goldens+replay/security/perf tests. Coordinator fixed privateglobals/nestedcoroutine/pcallguard; full84tests and9.73sexpander benchmark passed, goldenhashesunchanged.
- AT: complete10assets; final39modelvalidator+Pythoncompile passed. notes/AT.md.
- AC: complete20crop assets; coordinator checked exported triangle parity/budgets and mature previews. notes/AC.md records stage geometry decisions.
- AB: complete9assets; coordinator checked actualgeometry/budgets and hero previews. notes/AB.md records modeling decisions.
- V: returned renderer/assetloader;8Vtests passed per report. Coordinator mountedinspector/reference; stable-review now reviewing V/P/Lua.
- P: returned hardenedElectron+unsignedconfig+releaseworkflow;4policytests and macarm64appsmoke passed per report. No remote execution/publication.
- C2: owns main/RealSim/worker/protocol/types/loop/clock/store plus verifierUI/recovery tests; implements namespaces+ack+boundedmanualsync+watchdog.
- S2: owns server/src+test review fixes (strictadvancingchunks,pagedreplays,native413flush). No schema/config edits.
Agents write only brain/notes/<workstream>.md for reports; coordinator integrates.

## Baseline
- Original sim: 57 passed before copy.
- Copied full unit run: 56 passed, 1 timing failure (expander 28.6 s < 20 s assertion). Isolated test passed at 18.4 s. Correctness fine; timing must leave unit suite (D-008).
- Client does not compile yet: main imports deleted mock, game-loop uses old API. Agent C fixes.
- Blender live endpoint works (localhost:9876, Blender 5.3); headless common.py pipeline smoke passed; thumbnail checked visually. Smoke outputs removed.
- pnpm deps installed, including PGlite, ESLint, electron-builder. Browser Chromium cached.

## Remaining
Wave 1 core. Then renderer GLB loader/overlays and backend connection screens. Then client/server attack and replay tests plus review/full gate. Tier 5 and league services deferred, per D-010; no hosted authentication or publication without approval.

## Gate (coordinator runs, not agent reports)
Lint, typecheck, all unit tests, golden replay tests, production build, Playwright E2E without retries, Electron smoke. Repeat after fixes. A timing pass obtained only on retry does not count. No main integration without full green gate AND user permission to commit/merge.
