# Changelog

## Unreleased

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
