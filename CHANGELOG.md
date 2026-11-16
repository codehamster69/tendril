# Changelog

## Unreleased

- **Living island farm view**: the farm floats as an island in a golden-hour sky (Dawn, Noon, Golden, Night presets). New camera: left-drag pans, right-drag or Ctrl-drag orbits, the wheel zooms to the cursor, Q/E turn, WASD pans, pinch on touch, Home jumps back to the farm, F follows a drone. Lantern drones with light trails, fireflies, redrawn tiles, crops, barn, stall and hive. The view is drawn from the part of the farm on screen, so a farm of any size stays smooth, and zooming out turns it into a map with a minimap (click or drag to move the camera). Price lens and a market card show the shared daily market, with a stall next to the barn and harvest popups. Small replay and room views stay light (no HUD, trails or shadows).
- Keyboard: focus the farm and use arrow keys to select tiles (read out to screen readers), skip link to the editor, tab `aria-controls`.
- Site: phone menu, Season 1 in the header. Reference shows commands the way you type them. Starter code wraps in the editor, shorter toolbar labels, roomier instrument panel at 800 px height, market prices fold away once a result shows.
- Server: the late-submit grace for old desktop 0.1.x clients ends automatically after a quiet month (no earlier than 31 Dec 2026, no later than 1 Mar 2027).

## 0.2.2 (2026-11-13)

The Arena release. (Tags v0.2.0 and v0.2.1 never published installers: the first pointed at an old commit, the second failed the Windows build.) Desktop players get everything the web game has had since 0.1.2.

- **Daily farm**: one seed for everyone each UTC day, with three medals (Wealth, Speed to par, Brevity in Sprout tokens), a shareable emoji mosaic and sealed replays. Challenges generate themselves from the date with their own modifiers and par.
- **Season**: a weekly equal-start challenge, plus the Hall of Fame. The real-time ranked farm is now called Endless.
- **Duels**: Challenge a friend from any result, or press **Join duel** and paste a link. Accepting follows each other and opens the ghost race.
- **Replays and clips**: watch any verified run, race two farms on one clock, export an 8-12 second clip.
- **Room race**: up to 16 farms from one duel on one screen, ranked live.
- **Shared daily market (rules v4)**: from 8 Dec 2026, yesterday's sales move today's crop prices for everyone. Older dailies still replay under rules v3.
- **Humans vs models** board, CLI play (`tendril daily`, `tendril submit`), player pages, streaks and a README badge.
- **Desktop**: Docs and Leaderboard open in your browser, minimum window size, collapsible challenge card, no more false "worker did not reply" after pausing, no achievements for things a challenge starts you with.
- Runs itself: health watch, housekeeping and budget guard, automatic moderation, dependency updates and monthly releases.

## 0.1.2
Desktop auto-update from GitHub Releases; version shown in the app.

## 0.1.1
Near real-time Endless sync; ranked links work in the desktop app.

## 0.1.0
First release.
