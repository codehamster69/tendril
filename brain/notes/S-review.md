# S security/correctness review

Trust boundaries are largely sound, but three concrete defects remain. Scope: seven complete server source files, both complete migrations, and the complete test file, added/untracked versus baseline `10a25f9`; contracts, project rules and relevant shared-sim dependencies also read. Unrelated changes excluded. No tests executed; the reported 59 passes are not independently confirmed.

1. **P1 — Zero-span acceptance permanently strands the farm.** `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/server/src/game.ts:89-91,106-107`.
   Repro: submit an authenticated owner's current precondition with `fromTick=T`, `toTick=T`, `actions=[]`. Acceptance inserts the chunk while preserving tick/hash. Every subsequent advancing chunk from T receives 409 through duplicate detection—even after refetching. Minimal fix: reject `toTick <= fromTick` with 422 before replay/insertion; retain empty advancing chunks and the atomic transaction. No nonce, randomness or schema change is needed.

2. **P2 — Public replay materializes unbounded attacker-controlled history.** `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/server/src/game.ts:146-147`.
   Repro: submit ten advancing chunks/hour, each containing 20,000 legal failed buyPlot actions `[tick,-1,9,1000000000,1000000000]`. Within 24 hours, anonymous replay retrieval materializes approximately 150 MB of JSON/4.8 million action arrays, then serializes/buffers the response; lifetime growth is unlimited. Repeated unauthenticated retrieval repeats these allocations. Minimal fix: query bounded pages and stream or paginate replay output; bound concurrent downloads. Per-upload caps do not bound this read path.

3. **P2 — Oversized unfinished uploads lose the promised JSON 413.** `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/server/src/validation.ts:24-26`; `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/packages/server/src/dev.ts:25`.
   Repro: send chunked JSON exceeding 2 MiB without terminating the request. `reader.cancel()` destroys the Node-backed incoming stream/socket before the response is written, yielding a connection reset rather than JSON 413. Verified against installed Node v26.13.0's adapter and IncomingMessage implementations, not by executing tests. Minimal fix: flush 413 with `Connection: close` before destroying the incoming request; defer transport cancellation until response completion.

No additional confirmed defects in owner checks, service-only RLS writes, parameterized SQL, hashed opaque tokens, replay/version/clock/CAS, attempt locking, rejection rollback, sampled 24h growth or verified-only publication. Local authentication is explicitly prototype-only. PostgreSQL syntax and preservation of existing roles/auth.uid are sensible; Supabase execution/permissions and hosted authentication remain unverified—not hosted-production readiness.

Priority: zero-span rejection, bounded replay delivery, then transport-safe 413 handling.
