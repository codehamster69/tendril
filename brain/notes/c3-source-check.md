# C3 · Source check, Brevity medal, published solutions (2026-11-12)

(File is `c3-source-check.md` because the legacy `C3.md` note would collide with `c3.md` on case-insensitive disks.)

## What was added
- **lang**: `tokens.ts` (`countTokens`, exported from the package index), `verify.ts` (`verifySource`, `hashLog`; Node only, not exported from the index), `vercel-verify.ts` (function entry + `handleVerify`), `highlight.ts` (colour spans for the site, imports `api.ts` only).
- **api/verify.mjs** stub, `vercel.json` function entry, `scripts/build-api.mjs` builds `dist-api/verify.mjs` and **fails if the interpreter shows up in `dist-api/index.mjs`**.
- **server**: `verify-client.ts` (`SourceVerifier`, `remoteVerifier`, secret), `createApp({verifySource})`, `submitEntry` checks, routes below. `dev.ts` runs the check in-process.
- **client**: `publish.ts` (tick box, `submitWithProgram`), `submitRun(api, c, actions, source?)`, tokens line in the share text, result note.
- **site**: leaderboard page has "Published programs" (yesterday's daily / last week's season) with syntax colour.

## Contract (proposed additions to CONTRACTS.md, coordinator to fold in)
- `POST /challenges/:id/entries` body may carry `source` (<= 32 KB) and `sourcePublic`. With a source: the verify function must reproduce exactly the submitted log, else **422 `Source does not produce this run`** (`Source took too long to check`, `Source cannot be checked: Line N: ...`); **503** when the check cannot be made (nothing stored; send again without `source`). `tokens` is never accepted from the client (unknown field, 422). Response `tokens` is the server count.
- Same log sent again later with a source attaches the verified source to your existing entry (no 409). A log that already has a verified source stays a plain 409 repeat.
- **Brevity = fewest tokens among entries that reached par** (`tokens IS NOT NULL AND par_tick IS NOT NULL`; `keepIds` follows). Challenges with no par (duels of other lengths) have no Brevity. This changes A2's text "Brevity is empty until C3 sets tokens"; test in `arena.test.ts` updated.
- `GET /entries/:id/source` -> `{entryId, source, tokens, netWorth, parTick, sourcePublic, player, authorKind, model, challenge}`. 404 no stored program; 403 `Sealed until the challenge closes`; 403 `The author has not published this program`. Author always reads their own. Others need `source_public` and the replay sealing rule (closed, or duel participant).
- `GET /challenges/:id/sources?limit=` -> `{challenge, entries:[{entryId, login, displayName, avatarUrl, netWorth, parTick, tokens, mosaic, authorKind, model}]}`, only `source_public` entries, best net worth first. 403 until the challenge closes.
- Verify function: `POST /api/verify` with header `X-Tendril-Verify`, body `{source, challengeId, kind, seed, ticks, rulesVersion}` -> `{ok:true, tokens, logHash, actions}` or `{ok:false, reason, message}`. Anything without the secret gets 404.

## Token rules
Lexer tokens (words, numbers, symbols, strings). Free: comments, blank lines, indentation, line breaks. A string costs `ceil(chars/16)` (min 1) so a log cannot be stored in one literal. Documented in `tokens.ts`.

## Behaviour choices
- The client always sends the editor text with a signed-in submission (needed for Brevity); it stays private unless "Publish my program" is ticked (remembered per device, `tendril.publishSource`). If the server refuses the program (edited mid-run, hand-clicked farm, check busy) the run is resubmitted without it, so a score is never lost.
- Duels of 6,000 ticks run up to twice as long in verify; still far inside the 8 s deadline for realistic programs. A single bot burning its whole step budget every tick for 3,000 ticks takes about 5 s on this machine.
- Source is stored only when verified; `entries.source` is never returned by `/entries/:id` or boards.

## Needs from Rohan
- Nothing to set. Optional: `VERIFY_SECRET` in Vercel (defaults to a hash of `TURSO_AUTH_TOKEN`). The main function calls `PUBLIC_ORIGIN/api/verify` (falls back to `VERCEL_URL`), so `PUBLIC_ORIGIN` must point at this project's domain (it already does).
- After the first deploy, submit one program-carrying entry in production to confirm the two functions reach each other (Vercel Deployment Protection must not cover the production domain; it does not today).

## Known gaps
- No end-to-end test through real Vercel routing; unit and server tests use the real interpreter in-process and the remote client is covered only by shape. Worth a D-wave smoke test.
- The CLI (`tendril submit`) does not send its program yet, so CLI players get no Brevity entry. Easy follow-up: add `source` (and a `--publish` flag) to `submit()` in `packages/lang/src/arena-cli.ts`; `LastRun` already stores it. Its test server needs `verifySource` wired like `source.test.ts` does.
- Share text tokens line only shows for a verified program.
- F2's retry hook should wrap `submitRun` / `submitWithProgram`; it still has one call site.
