# SIGNIN1: desktop sign-in and unranked notice (packages/client only)

Files: electron/{preload.cjs,config.cjs,main.cjs,navigation.cjs,navigation.test.cjs}, src/{api-client,account,notice,main}.ts, src/style.css, index.html, e2e/{account.spec.ts,electron-smoke.mjs,notice.png}.
electron-builder.yml already ships electron/*.cjs (excludes *.test.cjs), so preload.cjs and config.cjs are packaged; no change.

Results: eslint 0; client typecheck 0; build 0; test:desktop-policy 7/7; test:e2e 34 passed, 0 failed, 1 skipped (shot.spec.ts, needs SHOT=1); test:electron passed.

Desktop flow: click Sign in (account dialog or notice bar) -> renderer makes a 48-hex nonce and calls window.tendrilDesktop.openExternal(https://tendril.hokora.xyz/api/auth/github?desktop=nonce) -> preload sends IPC -> main checks sender is the app window and isAllowedExternalURL (https, API origin, no userinfo, /api/auth/github path, one desktop nonce) then shell.openExternal. Button shows "Waiting for browser…" and is disabled; a dialog offers Cancel (Hide keeps waiting). Renderer polls POST /api/auth/desktop/poll every 2s (404/202/offline = keep waiting) for up to 5 minutes. On token: stored, button shows GitHub login, notice vanishes. Cancel quietly stops; timeout/other error toasts "Sign-in didn't complete." / "Try again.".

Unverified: the real GitHub round trip and real server poll responses (202 body shape) cannot be tested here. Hiding the waiting dialog leaves the button disabled until the 5-minute timeout (Cancel is only in that dialog).
