# M5: LibsqlError on /api

**Observed (Vercel get_runtime_errors, 7d):** `Unhandled server error: LibsqlError`, 7 hits, 3 users, route /api, 12 Nov to 17 Nov. Only the error name was logged, so the code was unknown. Runtime logs are not retained on Hobby beyond 1h, so the exact code could not be recovered.

**Cause (inferred from @libsql/client 0.18 source):** the web client maps remote failures to LibsqlError codes. Transient ones are `SQLITE_BUSY` (database busy), `SERVER_ERROR` (HTTP 5xx from Turso), and `HRANA_WEBSOCKET_ERROR` / `HRANA_CLOSED_ERROR` (dropped connection). Before this change every one of them became a generic 500 with no retry.

**Changed files**
- `packages/server/src/db.ts`: transient classification (`dbErrorCode`, `isTransientDbError`). Reads retry on busy and network codes. Writes retry only on busy, because a network failure may have applied the write. Transactions rerun only if they fail before commit. A failed commit is never retried.
- `packages/server/src/app.ts`: a busy error that survives retries returns 503 `{"error":"Storage is busy. Please try again in a few seconds."}` with `Retry-After: 5`. Everything else keeps the generic 500, so existing tests that pin that message still hold. Logs now record the libSQL code only.
- `packages/server/test/db-retry.test.ts`: new unit tests with a fake client.

**Verification:** server vitest 27 files / 656 tests pass. `pnpm typecheck`, `pnpm lint` and `pnpm build:web` pass. Not browser-verified: the failure cannot be reproduced locally.

**Open:** check `LibsqlError` codes in Vercel logs after deploy. The 503 path only logs codes, so a new code will show up there.
