# E1c: market in the game, site and docs (2026-11-12)

- sim: `describeMarket(date, market)` (arena.ts, exported): `soon` view ("Market opens in N days" / "tomorrow") before MARKET_EPOCH, `open` view (7 rows: name, price in coins, change vs base, yesterday's share) from the epoch. Text only, no rules.
- client: `marketPanel(c)` in `arena.ts` (daily only; countdown line or "Today's market" table, open by default), styles in `progression.css`.
- site: home "Today's farm" card shows the same (`marketOf` in `scripts/arena.ts`); new docs page `/docs/market/` (nav: Competing); Season 1 dates list mentions 8 Dec; daily and how-to-play link to it.
- Docs state the `price(item)` unit split (whole coins on v3 days, centicoins on market days) and that orders stay at base price.
- Tests: sim `describeMarket` (3), E2E arena "market countdown / prices". Playwright here needs `PLAYWRIGHT_BROWSERS_PATH` pointing at a dir that symlinks chromium-1243 as 1254.
