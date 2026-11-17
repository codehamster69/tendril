# U4 game sound and ambience

Files changed:
- packages/client/src/sound.ts (new): Web Audio sounds made in code, ambient wind and birds, settings, mountSound().
- packages/client/src/sound.test.ts (new): settings parsing, recipe bounds, merge, per-second cap.
- packages/client/src/main.ts: one import and one mountSound() call.
- packages/client/src/progression.ts: one line dispatching `tendril:medal` (detail = achievement id) next to the existing toast.
- packages/client/package.json: sound.test.ts added to the client test script.

Decisions:
- Nothing is created until the first pointerdown or keydown (AudioContext is built inside that gesture).
- Events: `tendril:events` drives harvest, sale, order and error. Batches merge to one sound per kind, most important first. A budget of 8 event sounds per second caps 4x and 16x.
- `tendril:status` running false to true plays the run sound. `tendril:scenario-end` plays sunset. Any button or link click plays a soft click.
- Plant has no event in the sim's event list, so it is not wired. play('plant') exists. Wiring it needs a plant event in the sim, which is out of scope for this task.
- Muted and volume come from Settings (`tendril.settings.v1`, followed live via `onSettings`); `tendril.sound.v1` only keeps `ambient`. `html[data-sound-gain]` shows the master gain once audio has started (e2e). Muting also suspends the context while the window is hidden.
- Public API for the menu task: getSettings, setVolume, setAmbient, setMuted, play.

Verification: client tests, typecheck and build pass. Headless Chromium: 0 AudioContexts before input, 1 after a click, no page errors. Not checked: audible output and the Electron app.
