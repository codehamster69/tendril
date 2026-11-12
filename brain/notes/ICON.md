# App icon

Script: `assets/scripts/render_icon.py` (headless Blender 5.3, engine BLENDER_EEVEE, standard view transform, transparent film, 96 samples, ~3 s).
Outputs: `assets/renders/icon_{1024,256,64,32}.png` (downscales via `sips`), copied to `packages/client/build/icon.png`.
Composition: squircle teal tile (card parallel to camera, teal gradient lighter at top), imported `bot_tender.glb` on `tile_soil.glb`, carrot s2/s1 and wheat s2 crops, one green tendril crossing the tile's top-right edge. Sun key from upper left, soft fill.
Iterations: 3 renders. electron-builder.yml unchanged (buildResources: build already picks up icon.png).
Assessment: 1024 reads cleanly: bot centred, ~56% of tile height, nothing clipped, transparent outside tile. 64 px still reads as a blue robot with plants on brown soil. Weaknesses: the tendril is the weakest element (its leaf only slightly breaks the silhouette and visually crowds the bot's basket sprout); soil tile side is pale tan and heavy; at 32 px the crops blur into soil.
.icns check: release/mac-arm64/Tendril.app/Contents/Resources/icon.icns is 1.4 MB (sha1 b39bd84c...), vs Electron default electron.icns 272 KB (sha1 c81b2354...): custom icon in use. `pnpm lint` exits 0.
