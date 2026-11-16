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
- Settings (volume 0.6, ambient on, muted off) are in localStorage key `tendril.sound.v1`. Muting also suspends the context while the window is hidden.
- Public API for the menu task: getSettings, setVolume, setAmbient, setMuted, play.

Verification: client tests, typecheck and build pass. Headless Chromium: 0 AudioContexts before input, 1 after a click, no page errors. Not checked: audible output and the Electron app.
