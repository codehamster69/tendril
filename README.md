# Tendril

**A daily coding puzzle where the server replays every move.**

<!-- REPLAY CLIP: place the exported clip at docs/img/replay.webm (or .gif) and embed it here before launch.
     Export one from the replay page with "Export clip" (client/src/clip.ts). Not recorded yet: the brief needs a real run. -->

Tendril is a farming game you play by writing a program. You script your bots in Sprout, a small plain-English
language, and watch the farm grow. Every day, and every week for a season, everyone gets the same farm. Your program
plays it, and the server plays your moves again to produce the score, so the leaderboard can be trusted.

- **Play:** <https://tendril.hokora.xyz/play/> in the browser, or download the desktop app from <https://tendril.hokora.xyz/download/>.
- **Learn Sprout:** <https://tendril.hokora.xyz/docs/>
- **Season 1:** <https://tendril.hokora.xyz/season-1/>
- **How scores are checked:** <https://tendril.hokora.xyz/blog/a-leaderboard-you-cant-fake/>

## How it works

- **Challenges.** A daily farm (3,000 ticks) and a weekly season farm (6,000 ticks). Everyone has the same seed. You can
  also challenge a friend to a duel on the same farm.
- **Three medals.** Wealth (highest net worth), Speed (earliest tick at par) and Brevity (fewest tokens in a program that
  reaches par).
- **Proven scores.** The game records your moves. The server rebuilds the farm from its own seed and replays them with
  the same rules code. An illegal move rejects the run. Replays are sealed until a challenge closes. If you attach your
  program, a separate function runs it and its output must match your submitted moves exactly.
- **What that proves.** A run is legal, and, with a program attached, that the program produced it. It does not prove a
  human wrote the program. Entries are labelled human or model by the player.
- **Endless farm.** The signed-in live farm has no end and is verified in the background.

## Play from the terminal

```
tendril login
tendril daily my.sprout
tendril submit
```

See the [CLI docs](https://tendril.hokora.xyz/docs/cli/).

## README badge

```md
![Tendril streak](https://tendril.hokora.xyz/api/badge/YOUR-LOGIN.svg)
```

## Repository

A pnpm workspace:

| Package | What it is |
|---|---|
| `packages/sim` | The rules. Integer maths, seeded, no clock or I/O. Shared by the game and the server. |
| `packages/lang` | Sprout: parser, interpreter, CLI and the source-check function. |
| `packages/server` | The API: challenges, boards, replay checks. Vercel functions and Turso. |
| `packages/client` | The web game and the Electron desktop app. |
| `packages/site` | The website and docs. |

```
pnpm install
pnpm dev          # the game
pnpm dev:site     # the website
pnpm check        # lint, types, tests, build, browser and desktop smoke tests
```

Contributors and agents: start with `AGENTS.md` and `brain/README.md`. The exact rules are in `docs/SIM_SPEC.md` and the
language is in `docs/LANGUAGE.md`.

If you find a way to post a score the rules would not give, please open an issue.
