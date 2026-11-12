# ATTACK1: adversarial test of the Tendril server (rules v3)

Test file: `packages/server/test/attack.test.ts` (272 tests; whole server package 379: 377 pass, 2 `it.fails` = the documented findings).
Checks: typecheck exit 0, eslint exit 0, `pnpm --filter @tendril/server test` 3 files, 377 passed + 2 expected-fail.
No source under packages/server/src or packages/sim was changed. No network, in-memory DBs, injected clock.

## Verdict
No request found that produces an unearned leaderboard score or damages another farm/the service. Two FUNCTIONAL findings:
server-side validation is stricter than the sim spec and rejects legal moves (F1, F2). They cannot inflate a score.

## Results
| Attack | Result |
|---|---|
| 1 extra fields netWorth/coins/hash/checkpoint/spent/stock/__proto__ in chunk | blocked 422 (strict key set; none stored); clean follow-up accepted; stored worth == independent replay |
| 1 forged checkpointHash | blocked 409 |
| 1 forged fields on POST /farms | blocked 400 |
| 2 toTick > floor((now-start)/100) | blocked 422 (boundary tick accepted); clock before start 422 |
| 2 span > 20000 | blocked 413 |
| 2 fromTick gap / overlap / replay of accepted chunk | blocked 409, state unchanged |
| 2 negative, fractional, string, null, array, bool, 1e308, 2^53, 1e400, MAX_SAFE ticks | blocked 422 (413 for MAX_SAFE toTick span); NaN/Infinity/leading zeros 400 |
| 3 busy bot, bot idx out of range / -1 / huge, farm op with real bot | blocked 422 |
| 3 unknown op, dir 4, crop 99/0, wait 0/1001/neg, sell 0/neg/2^53, item 0/99 | blocked 422 |
| 3 out of order, before fromTick, at/after toTick | blocked 422 |
| 3 non-array, short, extra element, float, string, null, nested, __proto__ entries (about 60 variants) | blocked 422, legal prefix not applied |
| 3 non-adjacent plot, too few coins for plot/bot, sell > stock | accepted as legal result 0, grants nothing (spec behaviour) |
| 4 rejected chunk leaves farms/chunks/history/board byte-identical; next valid chunk accepted | holds (10 variants incl. mid-log IllegalAction) |
| 5 20,001 actions | blocked 413, 5 ms |
| 5 body 2MB+1 | blocked 413, 2 ms; exactly 2MB accepted |
| 5 Content-Length oversize / junk | 413 / 400 |
| 5 nested JSON (100k to 1M deep), 2MB digits, huge string | blocked 400/413/422, all < 40 ms |
| 5 20,000 waits over 20,000 ticks | 200, 17 ms (limit 2000) |
| 5 20,000 ticks on 1,024 plots (1.47 MB checkpoint) | 200, 100 ms; GET /farms/me 1 ms |
| 5 daily 3,000 waits | 200, 3 ms |
| 6 sell/deliver with MAX_SAFE args, coordinates 1e9 | accepted as result 0 or 422; coins stay 0 |
| 6 (DB-tampered) delivery pushing coins past 2^53; already-unsafe worth | blocked 422 (overflow guards work) |
| 7 submit to another user's farm | blocked 403, victim untouched, victim quota unaffected |
| 7 unknown farm id | 404 |
| 7 read other user's data (checkpoint, tokens) via any route | not exposed; replay of verified farms is public by contract (seed + actions only); unverified 404 |
| 7 second farm | blocked: POST /farms idempotent (200 same id), 10 concurrent -> 1 row, DB UNIQUE(user_id) |
| 7 logged-out / expired (31d) / deleted token; malformed Bearer; token in query; bad Bearer + good cookie | all 401 |
| 8 10 concurrent identical chunks | exactly 1x200 + 9x409; one chunks row; score applied once |
| 8 10 concurrent different chunks | exactly one winner |
| 8 25 concurrent submissions | exactly 10 attempts recorded, 15x429 |
| 9 vary XFF/UA/Origin/Referer/Via/CF headers | no bypass, 429 on 11th |
| 9 path casing, trailing slash, //, dot segments, ;, %20, query, cookie vs bearer | 429 or 404/400, never processed |
| 9 daily 20/day | 21st 429 incl. query variants |
| 10 date outside today/yesterday, bad formats | blocked 422 |
| 10 log for another date | scored by server replay on submitted date's seed only |
| 10 actions at tick >= 3000 | blocked 422 |
| 10 lower / equal resubmission | best, achievedAt and rank unchanged |
| 11 wrong content type (8 variants), invalid JSON (14), invalid UTF-8 | blocked 400 (BOM is stripped and accepted: benign) |
| 11 wrong methods | 404 (not 405), no write |
| 11 path traversal, encoded slash/dots, SQL, null byte, 100k-char ids | blocked 400/404 |
| 11 cookie POST without X-Tendril-Client (also form/text-plain) | blocked 403, no attempt reserved |
| 11 foreign Origin (all methods) and preflight | blocked 403, no CORS headers; desktop origin Bearer-only, cookie ignored |
| 11 cookie flags | HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000, no Domain |
| 11 120-case random mutation fuzz | no 500; 3 accepted all equal independent replay, 117 rejected with checkpoint unchanged |
| 12 same chunk on two app instances | identical hash, checkpoint, net worth, tick |

## Findings
### F1 (functional, medium): legal ops 11-15 are rejected by the server
- Request: `POST /api/farms/:id/chunks` (or `/api/daily/submit`) with any entry `[t,0,11,1]` (build), `[t,0,12]` clear, `[t,0,13]` compost, `[t,0,14]` fertilize, `[t,-1,15,a]` unlock.
- Expected (SIM_SPEC Actions table; sim `validate`): legal, result 0 or 1. Actual: 422 "Invalid action".
- Cause: `packages/server/src/validation.ts` `validateActions`: `isInteger(action[2], 0, 10)` and the `length` / arg checks only cover ops 0-10.
- Impact: any run that researches (unlock), builds hives/composters or fertilizes can never be verified; unlock is required for wheat+, so progression is capped. No score inflation.
- Fix: allow op 0..15; lengths: 3 for ops 1,3,4,5,10,12,13,14; 4 for ops 0,2,6,7,11,15; 5 for 8,9; bot -1 for ops 9,10,15 and >= 0 otherwise (currently `op >= 9`: ops 11-14 need real bots); arg ranges: op 11 a in 1..2, op 15 a in 0..8.
- Test: `it.fails('VULN(F1, functional) ...')`.

### F2 (functional, medium): plant crop 5-6 and sell item 5-7 rejected
- Request: `[t,0,2,5]`, `[t,0,2,6]`, `[t,0,8,5|6|7,1]`. Expected legal (CROP_COUNT 6, ITEM_COUNT 8). Actual 422.
- Cause: `validation.ts` `op === 2 && !isInteger(a,1,4)` and `op === 8 && !isInteger(a,1,4)`.
- Fix: crop 1..6, sell item 1..7. Test: `it.fails('VULN(F2, functional) ...')`.

## Observations (not vulnerabilities)
- Extra fields are rejected (422), not ignored; stricter than the brief, fine.
- 403 "Not your farm" vs 404 reveals whether a random farm UUID exists; negligible (122-bit ids). Return 404 for both if desired.
- Public, unauthenticated `GET /leaderboard?board=growth` scans all ranked farms (noted in S3.md); only throttle is the host. Consider a materialised column or a CDN cache before launch.
- Sybil accounts (many users, one farm each) are not preventable by this design; each account has its own 10 chunks/hour.
- Overflow guards are unreachable from client input (net worth bounds coin growth); verified only by DB-tampered fixtures.
- BOM-prefixed JSON accepted (TextDecoder strips it).

## Timing (ms, in-process HTTP round trip)
20,001 actions 5; 2MB+1 body 2; nested JSON <= 40; 20,000 waits/20,000 ticks 17; same on 1,024 plots 100; daily 3,000 waits 3. All far below the 2 s bound.
