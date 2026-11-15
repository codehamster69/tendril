"""Island tiles and farm props, deterministic headless Blender.
    blender -b --factory-startup -P assets/scripts/tiles_props.py -- [--only name1,name2]
Tiles fill z in [-0.2, 0] with a 0.94 footprint (the gap between tiles is the readable grid), a flat top and a
small chamfer. Props stand on z = 0, centred on the tile, front toward -Y.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: F401  (sets sys.path)
import common
from kit import *  # noqa: F401,F403

S2 = math.sqrt(2)


def slab(top, side, top_z=0.0, lip=0.06, half=0.47, bevel=0.03, bottom=None):
    """Square slab from z=-0.2 to top_z. Side colour below the lip, top colour on the chamfer and top face."""
    r = half * S2
    rt = (half - bevel) * S2
    return lathe([(r, -0.2, bottom or side), (r, top_z - lip, side), (r, top_z - bevel * 0.6, top), (rt, top_z, top)],
                 4, color=top, phase=math.pi / 4)


def tile_grass():
    slab('grass', 'soil_side', lip=0.07)
    for x, y, h in [(-0.22, 0.17, 0.13), (0.2, -0.2, 0.11)]:
        for k in range(3):
            a = k * 2.1 + x * 5
            blade((x, y, 0), (x + 0.03 * math.cos(a), y + 0.03 * math.sin(a), h + 0.015 * k), 0.05, 'grass_hi', a)


def tile_soil():
    slab('soil', 'soil_side')
    for y in (-0.40, -0.14, 0.14, 0.40):
        block(-0.38, 0.38, y - 0.04, y + 0.04, 0, 0.026, 'soil_hi', taper=0.55)


def tile_wet():
    slab('soil_wet', 'soil_side')
    for y in (-0.40, -0.14, 0.14, 0.40):
        block(-0.38, 0.38, y - 0.04, y + 0.04, 0, 0.026, 'soil_wet_hi', taper=0.55)
    block(-0.30, -0.12, 0.21, 0.28, 0, 0.006, 'water_deep', taper=0.9)
    block(0.10, 0.31, -0.28, -0.20, 0, 0.006, 'water_deep', taper=0.9)


def tile_path():
    slab('path', 'soil_side', lip=0.05)
    for x, y, w, d, a in [(-0.22, 0.22, 0.28, 0.2, 6), (0.2, 0.2, 0.22, 0.24, -8), (0.0, -0.04, 0.3, 0.2, -4),
                          (-0.2, -0.3, 0.22, 0.2, 9), (0.22, -0.28, 0.26, 0.22, -6)]:
        box((w, d, 0.02), (x, y, 0), 'path_dark', taper=0.82, rot=(0, 0, a))
    for x, y in [(0.0, 0.34), (-0.36, -0.06), (0.37, -0.01)]:
        cone(0.04, 0.025, (x, y, 0), 'stone_light', sides=5)


def tile_water():
    slab('water', 'soil_side', top_z=-0.045, lip=0.0, bevel=0.025)
    block(-0.28, -0.04, 0.12, 0.17, -0.045, -0.04, 'glass', taper=0.9)
    block(0.04, 0.3, -0.2, -0.15, -0.045, -0.04, 'glass', taper=0.9)
    block(-0.36, -0.2, -0.3, -0.26, -0.045, -0.04, 'teal', taper=0.9)


def tile_terrace_wall():
    box((0.94, 0.94, 0.2), (0, 0, -0.2), 'stone_dark', taper=0.94, tcolor='stone_light')
    for side in range(4):
        c, s_ = math.cos(math.radians(side * 90)), math.sin(math.radians(side * 90))
        for z0, xs in [(-0.19, (-0.3, 0.0, 0.3)), (-0.095, (-0.15, 0.15))]:
            for x in xs:
                bx = box((0.27, 0.03, 0.082), (x, -0.46, z0), 'stone', taper=0.92)
                for v in bx.data.vertices:
                    v.co.x, v.co.y = v.co.x * c - v.co.y * s_, v.co.x * s_ + v.co.y * c


# ---- props ----
def prop_fence():
    for x in (-0.43, 0.43):
        box((0.1, 0.1, 0.5), (x, 0, 0), 'wood', taper=0.9)
        pyramid(0.1, 0.1, 0.07, (x, 0, 0.5), 'wood_light')
    box((0.1, 0.1, 0.34), (0, 0, 0), 'wood', taper=0.9)
    pyramid(0.1, 0.1, 0.06, (0, 0, 0.34), 'wood_light')
    for z in (0.16, 0.34):
        box((0.96, 0.045, 0.09), (0, 0.0, z), 'wood_light', taper=0.9)


def prop_crate():
    box((0.56, 0.52, 0.42), (0, 0, 0), 'wood', taper=0.97)
    for x in (-0.25, 0.25):
        for y in (-0.23, 0.23):
            box((0.07, 0.07, 0.44), (x, y, 0), 'wood_dark')
    for z in (0.12, 0.3):
        box((0.6, 0.02, 0.07), (0, -0.265, z), 'wood_light')
    for i, (x, y, c) in enumerate([(-0.14, -0.05, 'apple'), (0.1, 0.08, 'amber'), (0.0, -0.12, 'leaf_light')]):
        ico(0.1, (x, y, 0.45), c, subdiv=1, jitter=0.08, seed=i)


def prop_tree():
    cyl(0.09, 0.62, (0, 0, 0), 'wood_dark', sides=6, r2=0.06)
    for i, (r, x, y, z, c) in enumerate([(0.48, 0.0, 0.0, 0.92, 'leaf_dark'), (0.36, 0.12, -0.05, 1.28, 'leaf'),
                                         (0.3, -0.1, 0.05, 1.56, 'leaf_light'), (0.26, -0.22, -0.1, 0.8, 'leaf')]):
        ico(r, (x, y, z), c, scale=(1, 1, 1.1), subdiv=2 if i == 0 else 1, jitter=0.1, seed=i + 3)
    for i, (x, y, z) in enumerate([(0.3, -0.28, 1.0), (-0.2, -0.3, 1.2)]):
        gem(0.035, (x, y, z), 'pink')


def prop_rocks():
    ico(0.3, (-0.18, 0.0, 0.2), 'stone', scale=(1.1, 0.95, 0.65), jitter=0.16, seed=1)
    ico(0.22, (0.22, -0.1, 0.14), 'stone_light', scale=(1.0, 1.0, 0.7), jitter=0.18, seed=2)
    ico(0.15, (0.08, 0.2, 0.1), 'stone_dark', scale=(1.0, 1.0, 0.7), jitter=0.15, seed=3)
    ico(0.1, (-0.2, 0.0, 0.32), 'grass', scale=(1.1, 1.0, 0.45), jitter=0.12, seed=4)


def prop_signpost():
    cyl(0.04, 1.0, (0, 0, 0), 'wood_dark', sides=5)
    cone(0.06, 0.07, (0, 0, 1.0), 'amber', sides=5)
    for z, flip, c in [(0.84, 1, 'wood_light'), (0.62, -1, 'wood')]:
        x = flip
        extrude([(-0.28 * x, -0.06), (0.2 * x, -0.06), (0.32 * x, 0), (0.2 * x, 0.06), (-0.28 * x, 0.06)][::flip],
                z, z + 0.14, c, loc=(0, -0.06, 0), tcolor='wood_light')
    gem(0.035, (0, -0.1, 0.915), 'teal')


def _hex(r, n=6, ph=0.0):
    return [(r * math.cos(ph + 2 * math.pi * i / n), r * math.sin(ph + 2 * math.pi * i / n)) for i in range(n)]


def prop_flowers():
    cols = ['pink', 'amber', 'plum', 'cream', 'pink']
    pts = [(-0.2, 0.15, 0.3), (0.1, 0.2, 0.36), (0.22, -0.1, 0.28), (-0.1, -0.15, 0.33), (0.0, 0.0, 0.4)]
    for i, (x, y, h) in enumerate(pts):
        tube((x, y, 0), (x * 1.05, y * 1.05, h), 0.012, 'leaf_dark', sides=3)
        ico(0.065, (x * 1.05, y * 1.05, h + 0.03), cols[i], scale=(1, 1, 0.7), subdiv=1, jitter=0.15, seed=i)
        gem(0.025, (x * 1.05, y * 1.05, h + 0.075), 'amber' if cols[i] != 'amber' else 'amber_deep')
        a = i * 1.7
        leaf((x, y, 0.02), (x + 0.12 * math.cos(a), y + 0.12 * math.sin(a), 0.1), 0.4, 'leaf')


def prop_bush():
    ico(0.3, (0, 0, 0.26), 'leaf', scale=(1.25, 1.1, 0.85), subdiv=2, jitter=0.1, seed=7)
    ico(0.22, (0.22, -0.1, 0.2), 'leaf_light', scale=(1, 1, 0.8), jitter=0.12, seed=8)
    ico(0.2, (-0.22, 0.08, 0.2), 'leaf_dark', scale=(1, 1, 0.8), jitter=0.12, seed=9)
    for i, (x, y, z) in enumerate([(0.1, -0.26, 0.3), (-0.2, -0.2, 0.22), (0.3, 0.05, 0.28), (-0.05, 0.1, 0.5)]):
        gem(0.04, (x, y, z), 'pink')


def prop_lamp():
    cyl(0.06, 0.08, (0, 0, 0), 'stone_dark', sides=6, r2=0.04)
    cyl(0.025, 0.78, (0, 0, 0.08), 'black', sides=5)
    box((0.14, 0.14, 0.03), (0, 0, 0.86), 'black', taper=1.0)
    ico(0.09, (0, 0, 0.98), 'amber', scale=(1, 1, 1.2), subdiv=1)
    for x, y in [(0.075, 0.075), (-0.075, 0.075), (0.075, -0.075), (-0.075, -0.075)]:
        box((0.014, 0.014, 0.2), (x, y, 0.87), 'black')
    cone(0.12, 0.09, (0, 0, 1.08), 'roof_dark', sides=4, phase=math.pi / 4)
    gem(0.025, (0, 0, 1.2), 'amber_deep')


def prop_hay():
    for x, y, z, rz in [(-0.2, 0.05, 0, 8), (0.2, 0.0, 0, -6), (0.0, -0.05, 0.27, 3)]:
        box((0.38, 0.3, 0.27), (x, y, z), 'hay', taper=0.95, rot=(0, 0, rz), tcolor='hay_dark')
        box((0.4, 0.05, 0.28), (x, y - 0.0, z), 'hay_dark', taper=0.95, rot=(0, 0, rz))
    for x, y in [(0.3, 0.3), (-0.3, -0.3)]:
        blade((x, y, 0), (x + 0.04, y, 0.14), 0.04, 'hay')


def prop_cart():
    box((0.56, 0.4, 0.2), (0, 0, 0.18), 'wood', taper=1.12, tcolor='hay')
    box((0.52, 0.04, 0.05), (0, -0.2, 0.34), 'wood_light')
    for x in (-0.22, 0.22):
        lathe([(0.17, -0.025), (0.17, 0.025)], 8, (x, 0, 0.17), rot=(0, 90, 0), color='wood_dark')
        lathe([(0.06, -0.035), (0.06, 0.035)], 6, (x, 0, 0.17), rot=(0, 90, 0), color='amber_deep')
    tube((0.3, 0, 0.3), (0.52, 0, 0.45), 0.02, 'wood_dark', sides=4)
    ico(0.1, (-0.08, 0.0, 0.42), 'pumpkin', scale=(1, 1, 0.8), jitter=0.08, seed=2)
    ico(0.08, (0.12, 0.05, 0.4), 'leaf_light', jitter=0.1, seed=5)


def prop_scarecrow():
    cyl(0.025, 1.05, (0, 0, 0), 'wood_dark', sides=5)
    tube((-0.34, 0, 0.78), (0.34, 0, 0.78), 0.022, 'wood', sides=4)
    lathe([(0.0, 0.42), (0.1, 0.46), (0.14, 0.64), (0.09, 0.78), (0.0, 0.8)], 6, color='plum')
    ico(0.1, (0, 0, 0.92), 'cream', jitter=0.05, seed=1)
    cyl(0.17, 0.02, (0, 0, 0.99), 'wood_dark', sides=8)
    cone(0.1, 0.16, (0, 0, 1.0), 'plum', sides=6)
    gem(0.03, (0.0, -0.1, 0.92), 'black', sides=3)
    for x in (-0.34, 0.34):
        blade((x, 0, 0.78), (x * 1.12, 0, 0.64), 0.07, 'hay')
        blade((x, 0, 0.78), (x * 0.95, 0.0, 0.62), 0.05, 'hay_dark')
    box((0.18, 0.02, 0.1), (0, -0.1, 0.62), 'amber', taper=0.9)


def prop_pond():
    outline = _hex(0.46, 8, math.pi / 8)
    extrude(outline, 0, 0.06, 'stone', tcolor='stone_light')
    extrude([(x * 0.76, y * 0.76) for x, y in outline], 0.045, 0.062, 'water', tcolor='water')
    extrude([(x * 0.3 + 0.14, y * 0.3 - 0.1) for x, y in _hex(1, 6)], 0.062, 0.068, 'glass')
    ico(0.07, (-0.14, 0.12, 0.075), 'leaf', scale=(1, 1, 0.2), jitter=0.1, seed=3)
    gem(0.03, (-0.14, 0.12, 0.1), 'pink')


def prop_well():
    lathe([(0.24, 0, 'stone'), (0.24, 0.3, 'stone'), (0.2, 0.3, 'stone_light'), (0.2, 0.28, 'water_deep')], 8, color='stone')
    for sx in (-1, 1):
        box((0.05, 0.05, 0.5), (sx * 0.2, 0, 0.3), 'wood_dark')
    gable(-0.26, 0.26, -0.16, 0.16, 0.78, 0.18, 'roof', 'roof_dark', over=0.04)
    tube((-0.2, 0, 0.62), (0.2, 0, 0.62), 0.018, 'wood', sides=4)
    tube((0, 0, 0.62), (0, 0, 0.45), 0.008, 'cream_shade', sides=3)
    cyl(0.05, 0.07, (0, 0, 0.4), 'wood', sides=6, r2=0.06)


BUILDS = {
    'tile_grass': ('tile', grounded(tile_grass, tile=True)),
    'tile_soil': ('tile', grounded(tile_soil, tile=True)),
    'tile_wet': ('tile', grounded(tile_wet, tile=True)),
    'tile_path': ('tile', grounded(tile_path, tile=True)),
    'tile_water': ('tile', grounded(tile_water, tile=True)),
    'tile_terrace_wall': ('tile', grounded(tile_terrace_wall, tile=True)),
    'prop_fence': ('prop', grounded(prop_fence, 1.0, 0.8)),
    'prop_crate': ('prop', grounded(prop_crate, 0.7, 0.7)),
    'prop_tree': ('prop', grounded(prop_tree, 1.05, 1.95)),
    'prop_rocks': ('prop', grounded(prop_rocks, 0.95, 0.6)),
    'prop_signpost': ('prop', grounded(prop_signpost, 0.8, 1.3)),
    'prop_flowers': ('prop', grounded(prop_flowers, 0.8, 0.6)),
    'prop_bush': ('prop', grounded(prop_bush, 0.9, 0.7)),
    'prop_lamp': ('prop', grounded(prop_lamp, 0.4, 1.3)),
    'prop_hay': ('prop', grounded(prop_hay, 0.95, 0.7)),
    'prop_cart': ('prop', grounded(prop_cart, 1.1, 0.7)),
    'prop_scarecrow': ('prop', grounded(prop_scarecrow, 0.8, 1.2)),
    'prop_pond': ('prop', grounded(prop_pond, 1.0, 0.2)),
    'prop_well': ('prop', grounded(prop_well, 0.7, 1.1)),
}

if __name__ == '__main__':
    common.build(BUILDS)
