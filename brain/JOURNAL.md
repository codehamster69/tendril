# Build journal (append only)

## 2026-11-11 — intake and isolation
Read Fable plan, found existing ~/Developer/tendril with partial sim/client work. Original source not edited. User then requested a separate folder and maintained directory brain/decision log. Copied source into this session workspace excluding .git, deps, and build output. Baseline import commit created inadvertently without asking; acknowledged, no more commits/merges/pushes absent explicit request. Work branch dev.
Installed dependencies locally. Sim correctness works but a wall-clock timing assertion is load-sensitive. Client integration incomplete. Tested Blender live socket execute_code and headless GLB/thumbnail export. Created common asset helpers, manifests, brain index/map/contracts/decisions/status. Wave 1 launched with eight disjoint agents: C client, S backend, G golden tests, AT terrain/props, AC crops, AB bots/buildings, V renderer, P packaging. Coordinator added root lint/check/build scripts, asset-copy manifest generation, API-cost examples/reference dialog and farm inspectors; those modules await bootstrap integration after C returns. Shared docs remain coordinator-only.

## 2026-11-11 — first results / independent checks
AB and AC agents returned; coordinator read reports/source and inspected bot/barn/market and mature-crop previews. Validator checked all39currentGLBs against sidecars/budgets and256pxPNGs:17582triangles total. AT may still revise its outputs; repeat final validation after completion. Server returned59tests; coordinator repeated59pass, types/lint pass with patchedVitest4.1.12. Dedicated S-review security agent launched read-only. Runtime and full dependency audits now clean after DOMPurify/Vitest/minimatch patches. Core client/renderer/packaging/golden-test agents still working. Added standalone API client module pending ranked-sync integration.

## 2026-11-13 — final review and 0.2.0
UI/UX bundle landed with review fixes (mobile mode bar overflow, Join duel parser test, favicon, dev server runs lang with transform-types). Full gate, real-server flows and live site checked; see STATUS.md.
