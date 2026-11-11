# Workstream G — tests, golden strategies, performance separation

## Acceptance and outcome

Implemented the owned tests/scripts workstream. All 57 original tests and every original correctness assertion remain; only the two wall-clock performance assertions moved out. Added 21 golden checks and 6 sandbox checks (84 tests total). Final unit result is **80 PASS / 4 FAIL**, with all four failures exposing existing coordinator-owned Lua sandbox defects. Do not treat the overall gate as accepted or suppress these tests.

Read the entry brain files, simulation contract, and `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/docs/SIM_SPEC.md`. No simulation source, manifest, lockfile, permission/configuration, or other workstream file was edited. No commits, pushes, agents, services, full builds, or browser launches. The original Developer checkout was not accessed. Concurrent manifest/client/server changes visible in git status belong to other workstreams.

## Changed files (absolute paths)

- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/lua.test.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/perf.test.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/cli.test.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/replay-helpers.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/golden-run.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/golden.test.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/sandbox.test.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/fixtures/strategies.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/fixtures/lua-golden-v2.json`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/scripts/benchmark.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/scripts/generate-golden.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/scripts/sandbox-probe.ts`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/brain/notes/G.md`

## Decisions and fixture provenance

- Correctness stays independent of throughput. The existing million-tick/20,000-action replay retains both tick and hash assertions; expander retains clean errors, plot/bot growth, beating starter, and replay hash equality. The standalone benchmark preserves the strict original budgets: replay `< 2000 ms`, expander including engine startup `< 20000 ms`. It runs sequentially, once, with timings and an exit-code gate; no retries or increased budgets.
- Existing Lua tests now use a verification wrapper. Every completed live step is compared with full replay from its original serialized state and replay from a deserialized prior chunk checkpoint. Comparisons cover hashes, net worth, and complete snapshots, plus checkpoint round-trip. This also supports tests with deliberately funded initial worlds and restart tests. CLI success/error runs additionally verify full and checkpoint/chunk replay. Benchmark starter and expander do both replay paths.
- Goldens are finite assertion-bearing Lua strategies, with ticks ranging from 100 to 4500. All purchases earn coins through actual farming, not privileged fixtures. Explicit crop/soil/weather/order/stock/purchase assertions and completion markers prevent generation from blessing an accidental error or unfinished strategy. Two intentional API errors have exact predeclared bot/message expectations.
- Each fixture test executes the same seed twice, in three live takeLog chunks. Both runs must match the recorded hash/worth/errors/output, the entire action log must repeat exactly, and each chunk must match both replay paths. Forecast caches may contain different future weather; compare public snapshots/hashes rather than raw serialization bytes.
- JSON stores full script, seed, ticks, hash, worth, errors, output; file-level `rulesVersion: 2`, generator command, Node version and SHA-256 of ten simulation source files record provenance. The tests only read this JSON; they never import the generator or regenerate it.
- Generation is an explicit `--write` opt-in. It refuses other invocations with status 2, refuses RULES_VERSION other than 2, checks intended errors/completion, repeats every strategy, then writes only after all twenty pass. A byte-hash check confirmed refusal leaves the fixture unchanged.
- Fixture JSON SHA-256: `a4c3d37eb36fc0ea4b5d86f35e1248e5ed0cfa2ad038cd6838acbe198e739f14`. Recorded rule source SHA-256: `6a743e9b57c9494130b4ab6d45910d75d490e1d50c49bde8dc7a40cae835b725`; Lua source: `b4fe3a82dc333da76b2e95ac6db9cf46e352940e7d37655b8dd7eae9da0fe913`.
- Potentially unbounded sandbox probes execute in separate Node processes with a 10-second SIGKILL containment deadline. This is not a throughput assertion: Vitest cannot interrupt synchronous WASM. The documented 20M instructions remain a safety guard, not a game action cost or a restriction on conceptual thinking. No guard value or rules changed.
- CLI temporary directories are tracked and removed by afterEach, including failed assertions. Only test-created paths are removed.

### Recorded RULES_VERSION 2 fixtures

| Strategy | Seed | Ticks | Hash | Worth | Errors |
| --- | ---: | ---: | --- | ---: | ---: |
| counted-for-path | 7 | 300 | c611de9e | 0 | 0 |
| while-stage-wheat | 4 | 600 | 98f55899 | 24 | 0 |
| repeat-order-poll | 8 | 500 | 8c8235dc | 0 | 0 |
| nested-serpentine-sow | 4 | 700 | 80bb4866 | 0 | 0 |
| soil-clover-rotation | 4 | 1100 | dda49f41 | 49 | 0 |
| fatigue-fallow-recovery | 4 | 1000 | b5b9deb2 | 24 | 0 |
| forecast-read-ahead | 7 | 900 | 686c3ec6 | 0 | 0 |
| rain-aware-watering | 2 | 900 | 010690c5 | 0 | 0 |
| frost-hardy-vs-seedling | 1 | 1100 | 6f97e978 | 0 | 0 |
| signal-loop-counter | 12345 | 400 | eb463f8f | 0 | 0 |
| signal-shared-table | 0 | 400 | 4c7b824b | 0 | 0 |
| multi-bot-purchase | 4 | 2200 | 8214d20e | 88 | 0 |
| multi-bot-coordinated-stock | 4 | 3000 | 3fe94568 | 113 | 0 |
| stock-reserve-and-sell | 4 | 1400 | 7c8efde6 | 25 | 0 |
| stock-deliver-open-order | 8 | 1000 | 65ceadcd | 49 | 0 |
| legal-failed-actions | 42 | 400 | 5cc52caa | 0 | 0 |
| land-east-purchase | 4 | 4500 | ac597611 | 150 | 0 |
| land-negative-purchase | 4 | 4500 | 500f61ee | 150 | 0 |
| error-unknown-direction | 7 | 100 | 4215a93e | 0 | 1 |
| error-wait-range | 4294967295 | 100 | c32cb020 | 0 | 1 |

## Commands and real verification results

Commands are from the actual project scripts/compiler configuration; standalone scripts receive the same strict settings because the sim tsconfig only includes src/test. Use these absolute shell variables for the commands below:

```bash
ROOT=/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8
SIM="$ROOT/packages/sim"
```

- **PASS** explicit generation: `node --experimental-strip-types "$SIM/scripts/generate-golden.ts" --write`. Recorded the twenty hashes above after checking both repeats and all replay paths. Initial preparation attempt stopped before writing because my frost fixture incorrectly expected wheat stage 2; diagnostic input showed plantedAt 668, tick 755, rate 2, growth 174, so the exact spec expectation is stage 1. Corrected the fixture assertion before recording; no rules changed or assertion removed.
- **PASS** opt-in refusal: a Node spawnSync check invoked `node --experimental-strip-types "$SIM/scripts/generate-golden.ts"` without the flag, asserted exit status 2, and compared SHA-256 before/after. Actual output: `{"check":"generation opt-in","status":2,"fixtureUnchanged":true,"sha256":"a4c3d37eb36fc0ea4b5d86f35e1248e5ed0cfa2ad038cd6838acbe198e739f14"}` plus the explicit opt-in usage message.
- **PASS** package typecheck: `pnpm --dir "$SIM" typecheck` → `tsc --noEmit`, exit 0. Passed initially and after final test-code changes.
- **PASS** standalone script typecheck: `pnpm --dir "$SIM" exec tsc --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --types node "$SIM/scripts/benchmark.ts" "$SIM/scripts/generate-golden.ts" "$SIM/scripts/sandbox-probe.ts"` → exit 0, no diagnostics. Passed after final changes.
- **PASS** scoped lint: `pnpm --dir "$ROOT" exec eslint "$SIM/test" "$SIM/scripts"` → exit 0, no diagnostics. Uses the coordinator's now-present root flat config; no fixes/config edits.
- **FAIL** full unit gate: `pnpm --dir "$SIM" test --retry=0` → Vitest 3.2.7, 11 files passed / 1 failed, **80 tests passed / 4 failed**, exit 1, duration **30.87 s**. All original 57 and all 21 golden checks pass; the four sandbox failures below remain genuine red regressions. Earlier full run was 78 passed / 6 failed (30.71 s): two additional failures were my replay helper's `actions.push(...chunk)` exceeding the JS argument limit on large expander logs. Replaced that append with a per-entry loop and ran a fresh gate after this test-code change. Both runs used retry=0; no flaky pass was obtained by retry and no application logic was fixed.
- **PASS** isolated performance, a single invocation after the unit/typecheck processes completed: `node --experimental-strip-types "$SIM/scripts/benchmark.ts"`. Actual output:

```text
{"name":"replay: 1,000,000 ticks / 20,000 actions","ms":8.47,"budgetMs":2000,"pass":true}
{"name":"starter: 200,000 ticks (reference, not gated)","ms":553.71,"pass":true}
{"name":"expander: 200,000 ticks (including engine startup)","ms":13709.31,"budgetMs":20000,"pass":true}
{"correctness":"PASS","hash":"54caeb8e","worth":961190,"plots":20,"bots":28,"actions":1927045}
Performance gate: PASS (strict original budgets; no retries)
```

- **PASS** `git -C "$ROOT" diff --check -- packages/sim/test packages/sim/scripts` → no whitespace errors. Inspected original-file diffs: only timing assertions removed, all correctness assertions retained. Grep found no Date/performance calls, disabled/fails tests, or retry settings in correctness tests.
- Known slow tests, from the existing Vitest results cache (not another execution): Lua test file **20,006.69 ms**; sandbox file **30,392.78 ms**, dominated by three intentional 10-second containment kills. Golden file **422.33 ms**, large replay correctness file **146.61 ms**, CLI file **671.74 ms**. Cache: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`.
- **SKIP** repository-wide lint/typecheck/build/server integration gates: coordinator-owned scope, not required for this tests-only workstream. No environment or permission blockers occurred.
- **NOT RUN** renderer responsiveness / worker termination and recovery / browser and Electron interaction acceptance: not established by these Node probes and not implemented or launched here. The timeout probes also cannot reach dependent post-step tick/error/log/replay assertions because the VM does not return.
- Runtime verified: Node v26.13.0, pnpm 10.34.9, installed Vitest 3.2.7. Coordinator concurrently changed the manifest to Vitest ^4.1.12; this report does not claim validation of a later dependency reinstall. Coordinator must run the final gate on integrated dependencies.

## Sandbox failures — evidence and coordinator change requests

All locations below are in unedited `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/src/lua.ts`.

### FAIL: private scheduler / JS bridges exposed to player globals

Regression: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/test/sandbox.test.ts:27-43`. Expected no private `__` capabilities. Actual player enumeration returns 22 functions, including `__load_program`, `__spawn`, `__resume`, `__buy_plot`, `__forecast`, and unvalidated scan bridges. Registration/prelude are at source lines 145-160 and 182-209. Removed os/io/require/dofile/loadfile/package/debug checks, including text-load recovery probes, **PASS**; this does not hide the internal-capability defect.

Additional finite exploit was run using createVerifiedLuaRun, seed 7, 5 ticks (full/checkpoint replay passed). Reproduce with this player source:

```lua
if type(__load_program) == "function" then
  __load_program([[log("INJECTED"); bot.wait(1)]])
  __spawn(0)
end
bot.wait(1)
log("ORIGINAL")
```

Expected with private internals: output `[bot 0] ORIGINAL`. Actual: `{"tick":5,"errors":[],"output":["[bot 0] INJECTED"],"actions":[[0,0,7,1],[1,0,7,1]]}`. A player replaces its scheduled coroutine while the original is suspended. Required coordinator input: make scheduler and JS bridges genuinely private (captured capabilities/upvalues or a protected player environment), retaining the documented public API. Do not merely rename the exposed globals or remove the regression.

### FAIL: nested coroutine instruction-budget bypass

Two inputs in `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/sim/scripts/sandbox-probe.ts`:

```lua
local thread = coroutine.create(function() while true do end end)
local ok, err = coroutine.resume(thread)
if not ok then error(err) end
```

```lua
coroutine.wrap(function() while true do end end)()
```

The guard is installed only on the top-level bot coroutine at source lines 151-156; child threads do not inherit it. Expected: bot 0 `too long` error, step completes at tick 3, empty action log, and replay parity. Actual for each: stdout only `{"phase":"before-step","probe":"coroutine-create or coroutine-wrap","guardInstructions":20000000}`; no completion; parent kills after 10 seconds, status null, signal SIGKILL, error ETIMEDOUT. **NOT RUN** dependent world advancement/error/log/replay checks for these inputs.

Required coordinator input: preserve safety budget across user-created/resumed/wrapped coroutine trees, without restricting valid finite strategy thinking or altering action economics; ensure the client can terminate/recover an unresponsive simulation worker. Do not run the raw child command unbounded; reproduce through `pnpm --dir "$SIM" exec vitest run test/sandbox.test.ts --retry=0 -t coroutine-create` (or coroutine-wrap), which supplies containment.

### FAIL: catchable hook error can be swallowed forever

Input in the same sandbox child script:

```lua
while true do pcall(function() while true do end end) end
```

Expected: irreversible bot termination on the safety trip, host step returns. Actual: same before-step-only output and 10-second SIGKILL/ETIMEDOUT as above; no error reaches the scheduler. Source too_long uses ordinary catchable `error` at line 151. Ordinary nested-function non-acting code **PASS** and stops with `too long`, demonstrating that the guard works without these bypasses. **NOT RUN** dependent post-step/replay checks for pcall-repeat.

Required coordinator input: make safety termination non-bypassable by protected calls, with an out-of-VM worker watchdog/termination path as necessary. The renderer is isolated from Lua by the existing worker architecture; these findings establish simulation-worker nontermination, not an observed renderer freeze. Browser acceptance must verify the renderer remains interactive and worker recovery/errors are visible.

## Integration requests / uncovered scope

Coordinator should add an explicit root/sim `test:perf` entry invoking the absolute-workspace equivalent of `node --experimental-strip-types packages/sim/scripts/benchmark.ts`; G did not edit manifests. Fix the three sandbox defect classes in coordinator-owned source, keep the red probes, and rerun integrated unit/typecheck/lint plus isolated performance gates without retries after actual changes. No fixture regeneration is needed merely to conceal failures; any intentional baseline change requires explicit version/provenance review. Overall acceptance remains **BLOCKED** on sandbox fixes and unverified client worker/renderer interaction recovery.
