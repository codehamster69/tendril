# C2 + C6: resumable, lean catch-up (2026-11-17)

Changed: `packages/client/src/{real-sim,sim-worker,sim-protocol,game-loop,store,stage}.ts`, `stage.css`, `e2e/{catch-up,integration}.spec.ts`.

- Behind the clock by > 1,200 ticks (live farms), `RealSim.requestStep` runs **lean** steps: worker skips view events, output, heat, debug (C6); batch size adapts toward ~400 ms (500..20,000 ticks), worker slices of 500 ticks keep the 30 s reply watchdog fed.
- Full checkpoint (world + log chunk) every 20,000 ticks or 10 s; other lean steps are light. A reload resumes from the last checkpoint.
- Pending log is append-only: one IndexedDB key per chunk (`log.<id>`) plus ordered `logIdx`; saves write only new chunks and delete acknowledged ones. Old `pendingLog` arrays are read once and converted on the next save.
- Island redraws at most every 250 ms while catching up. Status carries `catchUp` (behind, %, ticks/s, ETA); `#catchup-card` shows it.
- Verified in headless Chromium: farm 500k ticks behind catches up, reload mid-way resumes, worst frame gap ~750 ms (software GL), integration+app e2e pass.
- Limit: raw sim speed (C1: ~107 ticks/s at 55 bots) is unchanged; that needs C5. Interpreter-level heat tracking is still on in lean mode (lang package).
