# AC — crop assets completed

## Owned deliverables

- `assets/scripts/crops.py`: exact 20-entry `common.build` table; imports common through the contracted script-directory sys.path insertion. Supports common's `-- --only` filter.
- `assets/export/crop_{carrot,wheat,clover,pumpkin,berry}_s{0,1,2,3}.{glb,json}`: 20 GLBs and 20 matching sidecars.
- `assets/thumbs/crop_{carrot,wheat,clover,pumpkin,berry}_s{0,1,2,3}.png`: 20 transparent 256×256 thumbnails.

Only AC deliverables were authored. No common.py, manifest, other workstream files, permission/configuration files, live Blender scene/socket, or ~/Developer/tendril changes. No installs, commits, or delegation. No contract/helper changes requested.

## Geometry and growth decisions

All geometry is authored in world coordinates on objects at `(0,0,0)`, so common's join retains the ground/tile-centre origin. Closed folded leaves use a shaped outline and raised midrib, not subdivided spheres. Stems use four-sided skew prisms. Vines use a continuous square-section mesh. Materials come exclusively from common.mat/common.PALETTE; common.finalize enforces the 300-triangle budget and owns joining/export/thumbnail rendering. No rigs, modifiers, smooth shading, or texture dependencies.

- Carrot: paired cotyledons; then increasingly wide serrated fronds above a tapered, visible orange root shoulder. Mature crown has six fronds.
- Wheat: three seedling blades; five juvenile stems; five developing ears; six larger mature golden ears with golden stems and narrow leaves. Economical serrated/ridged ear meshes, not individual grain spheres.
- Clover: paired rounded cotyledons; two, three, then four trifoliate clusters with notched heart-shaped leaves. One developing and two mature pale scalloped flower crowns.
- Pumpkin: broad cotyledons; lobed vine leaves; a developing fruit; then a larger six-rib orange pumpkin with brown stem, four leaves, and longer creeping vine. Alternating radial sectors and palette shading make the ribs legible.
- Berry: seedling, woody juvenile shrub, developing fruiting shrub, then broader fourteen-leaf canopy with four magenta bunches. Each bunch has three touching eight-triangle berries, attached at branch ends rather than scattered sphere foliage.

Each crop's X span, Y span, and height strictly increases from s0 to s3. All stages remain inside the tile-centred ±0.425m horizontal envelope; the largest actual footprint span is 0.646844m (mature carrot), below 0.85m. Every model reaches ground z=0 without below-ground vertices. Wheat intentionally has the tallest/narrowest silhouette (1.060m); mature clover and pumpkin remain low ground crops.

Thumbnail review prompted wider mature carrot/berry foliage, larger mature golden wheat heads, and a reproducible `paint.sl` studio preset with Standard/None color management. Juvenile clover/pumpkin heights were increased so stage growth is monotonic. Leaf winding was corrected and subsequently independently verified. Shared material colors were not changed.

## Actual final counts and dimensions

Dimensions are Blender X/Y/Z metres from the final sidecars. Counts were independently matched to triangle indices in each exported GLB, not only assumed from builder formulas.

| Asset | Triangles / 300 | X × Y × Z |
| --- | ---: | --- |
| crop_carrot_s0 | 28 | 0.190 × 0.098 × 0.150 |
| crop_carrot_s1 | 152 | 0.227 × 0.231 × 0.320 |
| crop_carrot_s2 | 232 | 0.406 × 0.401 × 0.490 |
| crop_carrot_s3 | 272 | 0.647 × 0.626 × 0.670 |
| crop_wheat_s0 | 24 | 0.152 × 0.149 × 0.190 |
| crop_wheat_s1 | 100 | 0.323 × 0.313 × 0.348 |
| crop_wheat_s2 | 280 | 0.446 × 0.433 × 0.736 |
| crop_wheat_s3 | 288 | 0.552 × 0.549 × 1.060 |
| crop_clover_s0 | 44 | 0.174 × 0.106 × 0.127 |
| crop_clover_s1 | 120 | 0.255 × 0.255 × 0.137 |
| crop_clover_s2 | 208 | 0.408 × 0.408 × 0.272 |
| crop_clover_s3 | 296 | 0.478 × 0.478 × 0.327 |
| crop_pumpkin_s0 | 28 | 0.205 × 0.105 × 0.162 |
| crop_pumpkin_s1 | 128 | 0.361 × 0.200 × 0.185 |
| crop_pumpkin_s2 | 236 | 0.482 × 0.448 × 0.232 |
| crop_pumpkin_s3 | 280 | 0.619 × 0.587 × 0.347 |
| crop_berry_s0 | 28 | 0.199 × 0.103 × 0.157 |
| crop_berry_s1 | 96 | 0.334 × 0.341 × 0.285 |
| crop_berry_s2 | 188 | 0.454 × 0.454 × 0.461 |
| crop_berry_s3 | 268 | 0.571 × 0.571 × 0.580 |

Total: 20 models, 3,296 triangles. Maximum individual count: 296/300 (mature clover).

## Checks and results

1. From the assigned repository root, ran `blender -b --factory-startup -P assets/scripts/crops.py`: exit 0, exact 20 successful common.finalize exports, no budget failures. Also verified common's --only path on the five mature names during thumbnail iteration.
2. Separate factory-startup Blender geometry audit: all 20 builders passed closed/manifold/contiguous-edge topology, positive signed volume (outward winding) for every component, flat shading, zero object location, no modifiers, palette-only materials, ground/envelope assertions, and common triangle budgets.
3. Independent standard-library GLB/JSON/PNG audit: exact 20 names per file type; one named mesh/node per GLB; identity node transforms; no skins, animations, or images; triangle-index counts match sidecars; no degenerate triangles; normals agree with winding; palette names AND color factors match common.PALETTE; matte roughness 0.85/metallic 0; glTF Y-up ground at y=0; exported bounds match sidecars; strict growth in all three dimensions for every stage transition. All 20 passed.
4. All thumbnails verified as 256×256 RGBA PNGs. Assembled a temporary contact sheet using Blender image pixels (system Pillow was unavailable; no install needed): `/tmp/ca45f3b8-AC-contact-sheet.png`. Rows carrot/wheat/clover/pumpkin/berry, columns s0/s1/s2/s3. Visually inspected the initial and final sheets with Read; final review confirmed serrated carrot crowns/orange shoulders, golden wheat spikes, low trifoliate clover/light blooms, ribbed pumpkins/creeping vines, and magenta berry bunches. No unrecognizable mature crop silhouette remained.

No blockers. Coordinator still owns manifest generation and client asset copying; neither was run or edited by AC.
