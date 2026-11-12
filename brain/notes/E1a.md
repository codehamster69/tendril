# E1a: shared daily market spec (2026-11-12, rev 3)

Spec only; no code. Rohan approved commit and merge at 19:08 UTC. Spec: `docs/SIM_SPEC.md`, section "Rules version 4 (DRAFT rev 2...)". Simulation: `brain/notes/E1a-market-sim.mjs` (`node` it; `SMOOTH=0` for unsmoothed; port to a sim test in E1b).

## Rev 2 decisions (from the coordinator, Fable's review)
Band 50..200%; daily cap 25 points (250 permille, read as points of base price); minimum 10 players; scale-free: each player's mix counts equally and each item's average share is compared with a fixed target share; 3:2:1 smoothing over three days; floor rounding; dailies only, seasons v3, duels copy their daily's table; orders stay at base price (documented hedge); net worth and par use the day's prices; challenge row carries rulesVersion and table; unknown versions refused with an update message; Sprout `price(item)`; `MARKET_EPOCH = 2026-12-08`.

## Rev 3 (Fable's follow-up)
Herding (scenario F) accepted as intended; no 4th smoothing day; cap = 25 points of base price; epoch day = base table. Target share is now blended: half `BASE_SHARE` (equal revenue), half the trailing mean of observed shares over 14 rows, skipping days under 10 players, fixed only until 7 valid days; each day's shares stored on the row (`sh`). Added scenarios (a) 90% carrot: settles at 75.4% (floor only days 3-6, before 7 valid days); (b) carrot to wheat shift on day 15: responds immediately at 25 pts/day, peak/trough day 20, re-centres to 169.5% / 72.1% by day 29. Trailing weight stays 1/2.

## My choices inside that
- BASE_SHARE = equal revenue split (units proportional to 1 / base price): 194, 129, 388, 65, 97, 78, 49 permille. No guessed volumes. Fixed for version 4. Easy to replace if Fable wants other targets.
- Each player's share vector is averaged (a whale counts once), so no volume cap constant is needed.
- A missing row or under-10-player day counts as neutral (1000) in the smoothing window.
- The lazy read touches at most two earlier rows, each storing its raw target `t`.
- Epoch day = base table; the day after derives from it (needs 10 players, else neutral).
- Legacy 0.1.x on a v4 day gets the existing rules-version 409 with an "Update Tendril" message (E1b must test it).
- `price(item)` returns centicoins.

## Simulation result (SIM_SPEC 4.7)
Band never left; blended target does not oscillate in A to E, (a), (b). Only the herding case F oscillates (accepted).

## Requests for E1b/E1c
- E1b: sim (`prices`, sell/netWorth, hash, serialize 3|4, `replayStats`, table helpers, `MARKET_EPOCH`, `challengeSetup(..., market)`), migration (`challenges.market`, `entries.sold`), `/challenges/:id` fields, verify function takes the table (par), `RULES_VERSION` bump sequenced with D4 (0.2.0), CONTRACTS.md, Sprout `price`.
- E1c: client refusal message, "Market opens in N days" / today's prices / yesterday's shares, winner bot announcement on 8 Dec, Season 0 page text, player docs on orders as the hedge.

## Verification
Sim run output in SIM_SPEC 4.7. Repo tests not run (no code changed).
