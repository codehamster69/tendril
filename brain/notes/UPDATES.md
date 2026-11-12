# Desktop auto-update (2026-11-12)

Changed: `packages/client/electron/updater.cjs` (+ `updater.test.cjs`), `electron/main.cjs`, `electron/preload.cjs` (adds `tendrilDesktop.updates`), `src/updates.ts`, `src/main.ts`, `src/style.css`, `index.html` (status bar `#app-version`), `vite.config.ts` (`__APP_VERSION__`), `electron-builder.yml` (github publish entry so latest*.yml are written; node_modules exclusion removed), `package.json` deps, root `test:desktop-policy`, `e2e/electron-smoke.mjs`, `.github/workflows/release.yml` (uploads latest.yml, latest-linux.yml, *.exe.blockmap; tag/version check).

Verified (Linux container): lint, typecheck, desktop-policy tests, unpackaged and packaged Electron smoke. End to end: a 0.1.1 AppImage pointed at a local feed holding a 0.1.2 build downloaded it, showed "ready", and replaced itself on quit. Asar ships only electron-updater and its 15 dependencies.

Not verified: Windows NSIS update and the macOS notify path on real machines.
