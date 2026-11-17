# HUD kit (U1)

File: `packages/client/src/hud-kit.css`, imported by `stage.ts`. Tokens are `--hk-*` (colour, `--hk-display/body/mono` type, `--hk-s1..s5` spacing, `--hk-r-sm/md/lg/pill` radius, `--hk-shadow`, `--hk-blur`), copied from the mockup. One dark look. Keyboard focus is a 2px lantern outline. Reduced motion switches transitions off.

Classes (reuse these, do not invent new chrome):
- `.hk-chip`: small glass pill for a readout. Children: `<small>` label, `<b>` mono number.
- `.hk-card`: glass panel for modals and floating cards.
- `.hk-button`: pill button; add `.hk-primary` for the lantern call to action. `aria-pressed="true"` shows pressed.
- `.hk-icon-button`: 2.4rem round button for one glyph (menu button). Needs `aria-label`.
- `.hk-overlay`: fixed full-screen dim layer that centres a `.hk-card`. Use `hidden` to hide.

Old `style.css` tokens (`--lantern`, `--teal`...) are still used by the legacy panels that live in modals. Later tasks replace them one by one.
