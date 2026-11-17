# U9: splash screen, loading, first run

Files: `packages/client/vite-splash.ts` (new, plugin), `vite.config.ts` (plugin line), `src/boot.ts` (new), `src/firstrun.ts` (rewritten), `src/stage.css` (first-run card styles), one-line `boot` calls in `main.ts`, `editor.ts`, `farm-view.ts`, `replay-main.ts`, `room-main.ts`, `electron/main.cjs` (window colour `#14110f`, `show:false` then `ready-to-show`). Tests: `e2e/splash.spec.ts`, `e2e/firstrun.spec.ts` (rewritten).

Decisions
- Splash HTML/CSS/tiny script is one source in `vite-splash.ts`, injected inline into index, replay and room pages at build and dev time, so it paints from the first HTML bytes and nothing is duplicated.
- Progress is real: weighted steps in `boot.ts` `PROFILES` (the one place P2 edits to reorder loading). Steps: script, save, models, worker, editor, frame. Replay and room use the `lite` profile.
- Splash holds until every step is done, min 600 ms, fades 400 ms; a CSS scale-in on the canvas stands in for the camera glide so the PR #68 camera is untouched. Slow after 8 s (status line), failure message plus Retry on script/style load error, `boot.fail`, or 30 s timeout.
- One tip per load, rotated through a localStorage counter, chosen by the inline script.
- First run: three prompts (starter/type, Play, first harvest, then the sale ends it) as a floating `.hk-card` next to the real controls, driven by `tendril:events`. Skippable (Esc too), flag `tendril.firstrun.v1`. Starter is lesson 1's solution.
