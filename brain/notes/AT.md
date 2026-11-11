# AT — tiles and farm props

## Scope and delivery

Workspace: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8`.

Created `assets/scripts/tiles_props.py`, exactly ten owned GLBs and ten sidecar JSONs in `assets/export/`, and the corresponding ten PNGs in `assets/thumbs/`. This note is the only documentation change. Read `assets/scripts/common.py` and the assets section of `brain/CONTRACTS.md` before implementation. No edits to common.py, manifest files, make_manifest.py, or other workstreams. No network, dependency installation, commits, delegates, live Blender scene access, or access to `~/Developer/tendril`.

## Final triangle counts

Counts were checked by common.finalize and independently against exported GLB triangle index accessors.

| Asset | Triangles | Budget | Design |
| --- | ---: | ---: | --- |
| tile_grass | 66 | 300 | Closed relief tile; subtle triangulated height variation and irregular darker turf facets. |
| tile_soil | 214 | 300 | Five cultivated ridges, recessed dark furrows, and lightly broken shoulders. |
| tile_wet | 274 | 300 | Dark damp soil, deeper broken furrows, three drying facets, and tiny retained-water slivers. |
| tile_path | 228 | 300 | Six individually rotated clipped-corner stepping stones on sandy earth with irregular grassy verges. |
| tile_terrace_wall | 300 | 300 | Two staggered masonry courses, broad chisel bevels, clipped stone corners, recessed mortar, and two capstones. |
| prop_fence | 492 | 1500 | Five pointed pickets, two rails, capped end posts, collar bands, and small nail heads. |
| prop_crate | 1156 | 1500 | Open slatted crate, visible floor boards, corner uprights, beveled rim, fitted diagonal brace, and fasteners. |
| prop_tree | 668 | 1500 | Tapered trunk, three root flares, forked branches, and seven sculpted faceted leafy crown lobes. |
| prop_rocks | 306 | 1500 | Six irregular rocks in mixed sizes, grounded flat undersides, restrained dark facets, and two grass tufts. |
| prop_signpost | 254 | 1500 | Wooden post with pointed cap, opposed arrow boards, foot collar, bolts, and grain scoring. |

The terrace wall uses its full budget; any additional geometry must replace existing triangles rather than add to them.

## Implementation decisions

- Explicit script-directory sys.path import of common; common.build has exactly the ten contracted entries and retains common's --only support.
- All five tiles occupy exactly X/Y `[-0.5, 0.5]` and Z `[-0.2, 0]`. Relief, stone tops, and water details never protrude above ground.
- The terrace asset is a terrain masonry riser within the contractual 20 cm tile thickness, not a freestanding above-ground wall. Eight custom 36-triangle sculpted stones plus a 12-triangle mortar core total 300.
- Wet soil remains predominantly dark earth. Its three small matte water slivers cover less than 1% of the tile and distinguish watered ground without making it a flooded tile.
- Used only common.PALETTE names. Materials are flat, roughness 0.85, metallic 0. No textures or rigs. All meshes are joined by common.finalize and exported through common's glTF Y-up conversion.
- Every source mesh receives origin `(0,0,0)` before joining. Props are centred on their complete horizontal bounds and grounded at minimum Z = 0; tiles retain their exact unit footprint and recessed ground slab.
- common.cube and common.sphere apply creation location along with scale. Without changing the shared helpers, construct at zero and then position locally where rotation/sculpting needs a component-centred origin. This corrected the first crate brace placement and improved tree/rock grounding.
- Removed unused primitive UV layers before bevel evaluation. Palette-only exports need no UVs; this also removes irrelevant bevel UV rounding variation between rebuilds.
- Disabled Python bytecode writes before importing common; compilation checks also created no bytecode files.

## Commands and actual results

Commands ran with the workspace root as working directory, using installed Blender 5.3.0.

1. `blender --version` — PASS; Blender 5.3.0 available locally.
2. `python3 -c "from pathlib import Path; p=Path('/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/assets/scripts/tiles_props.py'); compile(p.read_text(), str(p), 'exec'); print('Python syntax: PASS (no bytecode files)')"` — PASS, including after the final edit.
3. `blender -b --factory-startup -P assets/scripts/tiles_props.py` — PASS, exit 0. Full runs generated all ten GLB/JSON/thumbnail triplets; every common.finalize budget check passed. Final counts are in the table above.
4. `blender -b --factory-startup -P assets/scripts/tiles_props.py -- --only tile_wet,prop_crate` — PASS, exit 0; only the selected assets rebuilt. Additional `--only tile_wet` and `--only prop_fence` runs also exited 0 while diagnosing reproducibility.
5. `python3 -` with an inline standard-library artifact validator — PASS for all 30 final outputs. Checked exactly ten build entries; GLB headers/chunks; one mesh and one identity-transform node per asset; actual triangle counts and budgets; finite coordinates; identical normals per triangle; Y-up bounds and zero ground origins; sidecar dimensions; exact palette colours, roughness and metallic values; no UVs/textures/rigs/cameras; and 256x256 RGBA PNG headers, CRCs and decompression.
6. `python3 -` with a subprocess full-rebuild and SHA-256 comparison — final PASS, exit 0. All 20 GLB/JSON files were byte-identical across final complete builds; all ten decompressed PNG scanlines were identical. common.py and make_manifest.py hashes also stayed unchanged.
7. Visual inspection using Read for all ten asset thumbnails — PASS. Corrected the protruding crate brace, grounded/sculpted the tree and rocks locally, exposed the terrace cap bevels, and made wet soil more legible before final export. Remaining assets have readable silhouettes and the intended low-poly flat style.

An exploratory raw byte-for-byte comparison initially failed because Blender writes changing PNG Date/RenderTime text metadata, and the fence's unused generated UV coordinates varied by approximately 5.96e-8. Diagnosis confirmed identical rendered pixels and no position/normal changes. Removed unused UVs and compared PNG pixels rather than timestamp metadata; the final rebuild comparison passed. PNG metadata remains untouched because thumbnails are produced by common.

Pillow is not installed; inspected thumbnails individually with Read instead of creating a contact sheet or installing anything.

## Remaining work

No AT blockers or missing outputs. Manifest generation and client asset-copy integration remain coordinator-owned and were not changed.
