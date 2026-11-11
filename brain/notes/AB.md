# AB — bots and buildings

## Delivered files

Root: `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8`.

- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/assets/scripts/bots_buildings.py`
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/assets/export/{name}.glb` and `{name}.json` for exactly the nine names below (18 files).
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/assets/thumbs/{name}.png` for the same nine names (9 files, 256 × 256, transparent).
- `/Users/rohan/Documents/Qoder/2026-11-11/ca45f3b8/brain/notes/AB.md`

29 owned deliverables total. No edits to common.py, manifest, other workstreams, configuration, or dependencies. No scene files, socket access, dependency installs, delegation, commits, or publishing. The original checkout was not accessed.

## Final counts and Blender-space dimensions

| Exact name | Group | Triangles / budget | X × Y × Z (m) |
| --- | --- | --- | --- |
| bot_tender | bot | 1212 / 1500 | 0.557 × 0.413 × 0.657 |
| bot_tender_v1 | bot | 1316 / 1500 | 0.557 × 0.413 × 0.672 |
| bot_tender_v2 | bot | 1304 / 1500 | 0.564 × 0.413 × 0.708 |
| bot_tender_v3 | bot | 1476 / 1500 | 0.555 × 0.430 × 0.769 |
| prop_barn | building | 1064 / 3000 | 0.878 × 0.847 × 0.824 |
| prop_market | building | 1786 / 3000 | 0.864 × 0.768 × 0.921 |
| prop_water_tank | prop | 904 / 1500 | 0.554 × 0.632 × 0.803 |
| prop_beehive | prop | 604 / 1500 | 0.534 × 0.564 × 0.703 |
| prop_compost | prop | 662 / 1500 | 0.708 × 0.621 × 0.637 |

Total: 10,328 triangles. All bots are below 0.8m tall and 0.6m in either footprint axis; barn is below 0.95m in both axes. JSON dimensions are rounded to three decimal places; unrounded exported geometry also passed the limits.

## Design and integration decisions

- Tenderbot: two-segment chamfered blue chassis, round side pods, capsule-shaped rubber treads, metal wheels with yellow hubs, pale bordered face, luminous pale eyes, tiny smile and amber cheeks. The base carries a growing planter and spade. V1 visibly carries a watering tank, cap, handle and shower nozzle; V2 carries a honey-coloured harvest basket with carrots and a sickle; V3 adds a four-cell solar canopy, antenna, living planter and articulated pincer. Upgrade indicators increase across versions.
- Barn: individual red timber boards over dark red backing, solid triangular gables, two thick pitched roof slabs with ridge cap, exposed white side bracing, double planked doors with X braces, hinges/handles and a framed loft window.
- Market: braced timber stall, eight alternating red/white bent canopy strips with scalloped valance, counter, three visible produce crates, rear storage boxes and a hanging grain/price motif. Raised the canopy and moved crates forward after thumbnail review to avoid occlusion.
- Tank: faceted metal reservoir, blue band and water-drop badge, level gauge, four grounded legs and braces, hatch, ladder and a projecting valve/spigot.
- Hive: three honey boxes with seams and handles, wooden gable roof, entrance slit, landing board, feet and bee emblem.
- Compost: spaced wooden slats, upper-front access opening, dark faceted fill, leaf/carrot scraps and a parked fork.
- All colours reference common.PALETTE through common materials. Bot_light adds low-strength emission from its existing palette value; roughness remains 0.85 and metallic remains 0. No textures or rigs.
- The grounded wrapper measures evaluated geometry, asserts bot/barn limits, centers the full silhouette, places its lowest vertex on z=0, then sets every mesh origin to the world cursor before common.finalize joins it. This avoids inheriting a primitive-centred root transform.
- Local beam construction accommodates common.cube baking primitive location: create the beam at zero, rotate, then position it. Custom meshes use outward winding. No shared helper change was needed.
- Preview-only Standard colour management and light cavity shading keep the palette and facet edges readable; exported material colours are unchanged. Final thumbnails were individually inspected via Read.
- Barn/market use the building group; tank/hive/compost fit the stricter 1500-triangle prop group.

## Actual checks

1. Read common.py, the Assets contract, and the brain ownership/convention files before implementation.
2. Ran `blender -b --factory-startup -P assets/scripts/bots_buildings.py` from the root using Blender 5.3.0. First run exited 1: bot and barn footprint assertions exposed the rotated-beam placement bug. Fixed it locally and corrected custom-mesh winding.
3. Ran the same full command again: exit 0, all nine assets exported/rendered under budget. Read all nine thumbnails. Increased chassis rounding, added round side pods, exposed barn side bracing, improved market produce visibility, and adjusted preview colour management.
4. Final full headless command: exit 0, all nine `[asset]` entries succeeded with the counts above. Read all nine final thumbnails: upgrades are visibly distinct; barn gable/braces and market crates are readable; no clipped silhouettes.
5. Independent Python standard-library validation parsed the build table, all nine GLB binary/JSON chunks and their geometry accessors, sidecars and PNG headers: exit 0. Actual output ended `PASS: exact nine build names; 9 GLBs + 9 JSONs + 9 matching 256px PNGs; all exported geometry checks passed.` Checks covered:
   - Exact build names; nonempty valid GLB v2 files and matching JSON names/groups/budgets.
   - One mesh and one named node per GLB, identity translation/rotation/scale, no rigs/animations/textures.
   - Exported indexed triangle counts equal sidecars and remain below each group's budget.
   - Actual Y-up GLB positions have minimum Y=0 and centered X/Z footprint; dimensions match Blender-space sidecars within rounding tolerance.
   - Unrounded bot height/footprint and barn footprint limits.
   - Every exported material name/value matches common.PALETTE; roughness 0.85, metallic 0; bots have emissive eyes.
   - Every exported triangle's three normals agree (flat shading).
   - Nine matching PNG signatures and 256 × 256 IHDR dimensions.
6. Scoped git status confirmed the script and the 27 generated AB assets are present as untracked deliverables; no staging or commits.

## Remaining

No AB blockers or requested helper/contract changes. Coordinator still owns manifest generation and the client copy/load integration. Global client/server gates were not run for this asset-only workstream.
