# UIUX review (pass 1, main at 8698953, 2026-11-12)

Method: built the site and the web game, ran the local server, drove the game in Chromium at 1280x800, 1400x900, 1024x640 and 900x600, crawled every site page (links, anchors, headings, alt text, mobile overflow). Not covered: real Electron window, signed-in flows (local dev login returned 500 in this sandbox), the market (E1b/E1c), the streamer room (E2). Pass 2 covers those once they merge.

## Fixed in this pass (uncommitted)
1. **Idle farm reported a dead worker after 30 s** (high). `real-sim.ts` armed a reply watchdog on every command but never cleared it on a reply, so any pause or finished challenge longer than 30 s showed "Worker did not reply... Choose Restart worker" and terminated the worker. Now cleared on reply, re-armed on progress. Verified: sandbox idle for 60 s stays "Paused".
2. **Achievements fired from the starting state** (medium). Daily and Season start with coins and wheat researched, so "Market day / Reach 1 coins" and "Wheat researcher" popped over the farm on load and were stored as earned. Those already true at the first snapshot of a challenge are now ignored. Also "1 coins" is now "1 coin".
3. **Docs getting started contradicted the game** (medium). It said new farms start with a pasted program and never mentioned modes. The first Endless run is a three-line tour, and the built-in starter is longer than the one shown. Reworded, and added a section on the five modes plus next-step links.
4. **Docs pages not reachable** (medium). `/docs/cli/` and `/docs/models/` were in no nav; `/season-1/` was linked only from the blog post. Added both docs to the sidebar and Getting started, and Season 1 to the footer.
5. **Desktop window could shrink to a useless size** (low). No min size, and below 1100 px the layout stacks and the farm collapses to a sliver. Electron now has min 1100x680.

6. **Desktop site links** (coordinator approved). Docs, new Leaderboard link and the brand link open in the system browser via `isAllowedSiteURL` (navigation.cjs): https, site origin only, fixed pages (`/`, docs, leaderboard, season-1, download, blog, `/r/<id>`), no query/port/credentials, plus the GitHub releases page. 12 policy tests pass.
7. **Challenge card** now has Hide/Show details, and scrolls inside 46vh so the editor stays visible.
8. **Joining a duel from the desktop app** (found when Rohan asked where duels live). Duel links are site pages (`/duel/?id=`), and the app had no place to paste one. Added "Join duel" in the mode bar (`join-duel.ts`): paste a link or id, opens `?mode=challenge&id=...`.

## Where each mode lives (as of main 0982dfa)
Arena = Daily and Season tabs (web and desktop). Duel = Challenge a friend on a finished Daily/Season result (sign-in needed), friend opens the link or pastes it into Join duel. Replay and room race are web pages only (`/r/<id>`, `/play/replay.html`, `/play/room.html?id=<duel>`, reached from the duel page). Market engine merged (#36), UI pending E1c.

## Pass 2 (main d1c8e1f, includes E1b/E1c/E2)
- Market panel checked with a mocked 10 Dec day: table renders, trends carry +/- signs not only colour, Season shows none (dailies only), docs page `/docs/market/` and nav entry fine, no overflow at 390 px.
- Fixed: the challenge card now keeps its natural height up to 46% of the window instead of being squeezed by the editor, so the countdown and prices stay readable.
- Rebased my fixes onto main; merged the fold button with the market panel in `arena.ts`.
- E2E: arena, duel and account specs 20/21 pass; the one failure is the known swiftshader timing flake in "a farm far behind catches up" (#37 territory).
- Still open from pass 2: market table is taller than the card cap, so the last row (Honey) needs a scroll; collapse the table once a result shows.
- Not verifiable here: real Electron window, signed-in flows against a live server, the room page on a phone.

## Open (priority order; numbering restarts)

**All items below fixed on 2026-11-13** (thread "Polish remaining UI rough edges"): 4 stage min height 250 and deck min 150; 5 reference shows commands as written (`move direction`); 6 toolbar labels Step and +100; 7 editor word wrap; 8 site Menu on phones plus Season 1 in the header; 9 tabs `aria-controls`, skip link, farm canvas focusable with arrow keys and a screen reader announcement; 10 caption reworded; 11 practice says "No deadline in practice"; 12 Season 1 in header and AI models in the menu; pass-2 market table folds when a result shows.

4. **Farm instruments panel is cramped at 800 px height** (medium). Farm, Research and Achievements show about one row. The 3D view takes the space; consider a resizable split or a smaller default stage.
5. **Reference shows `move(direction)` but the language is `move east`** (low, copy). Signature style and the Insert text disagree; show the pseudocode form first.
6. **Toolbar wraps to two rows in challenge modes** (low). Step line, +100 ticks and Speed push Reset and Reference down. Group the debug buttons or shorten labels.
7. **Starter code in Daily/Season has very long unwrapped lines** (low). The `for each tile in [{x: 1, y: 0}, ...]` line is clipped. Wrap it in the generator.
8. **Site header hides Reference and Leaderboard under 420 px, no menu** (low). Leaderboard remains in the footer only on phones. Add a compact menu.
9. **Tabs have no `aria-controls`; no skip link in the game; the 3D canvas is not keyboard operable** (low to medium accessibility). Keyboard users cannot inspect tiles. A tile list or arrow-key picker would fix it.
10. **Home demo says "no coins" but shows 50 coins** (low copy). Reword to "50 coins" or start the demo at 0.
11. **"Time left open" on practice challenges** (low copy). Say "No deadline in practice".
12. **Site nav has no Season 1 or Models entry in the header** (design). Held back: header space is tight. Revisit when the market page lands.

## Site and docs health
Crawl of 16 linked pages plus cli, models, season-1, blog, duel, u: no broken internal links or anchors, one h1 per page, descriptions present, no images without alt text, no horizontal scroll at 390 px. The only console errors were from my stub API. External links point at the v0.1.2 release assets.

## Pass 2 checklist (after E1b, E1c, E2, CI gate merge)
Price display in game and site, market docs page and nav entry, Season 0/1 wording around 8 Dec, streamer room flow, desktop auto-update notice, real Electron window, signed-in flows, duel link and replay page.
