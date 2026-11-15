"""Crop clusters (stages s0..s3) and carried items. Origin = tile centre at ground level (z = 0).
    blender -b --factory-startup -P assets/scripts/crops.py -- [--only name1,name2]
Stage drives size and maturity; s3 (ripe) is clearly distinct: larger, with fruit/heads in the crop colour.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit  # noqa: F401
import common
from kit import *  # noqa: F401,F403


def ring(n, radius, phase=0.0, jitter=0.0, seed=0):
    out = []
    for i in range(n):
        a = phase + 2 * math.pi * i / n
        r = radius * (1 + jitter * (hash01(seed, i) * 2 - 1))
        out.append((a, r))
    return out


def sprout(color='leaf', scale=1.0):
    for a in (0.4, 3.5):
        leaf((0, 0, 0.01), (0.1 * scale * math.cos(a), 0.1 * scale * math.sin(a), 0.07 * scale), 0.5, color)


def carrot(stage):
    if stage == 0:
        return sprout('leaf_light')
    n, length, roots = [(0, 0, 0), (4, 0.2, 1), (6, 0.3, 2), (8, 0.4, 3)][stage]
    for i, (a, r) in enumerate(ring(n, 0.05, 0.3, 0.2, 11)):
        reach = 0.05 + 0.04 * stage + 0.07 * hash01(i, 3)
        leaf((0.02 * math.cos(a), 0.02 * math.sin(a), 0.05),
             (reach * math.cos(a), reach * math.sin(a), length * (0.8 + 0.25 * hash01(i, 5))),
             0.36, 'leaf_dark' if i % 2 else 'leaf', lift=0.2, droop=0.03 * stage)
    for k in range(roots):
        a = 2.2 * k + 0.5
        x, y = 0.09 * math.cos(a) * (roots > 1), 0.09 * math.sin(a) * (roots > 1)
        big = 1.0 if stage == 3 else 0.8
        lathe([(0.0, -0.01), (0.06 * big, -0.01), (0.075 * big, 0.025), (0.05 * big, 0.06), (0.0, 0.075)], 5, (x, y, 0), color='carrot', phase=a)
        cone(0.025 * big, 0.04, (x, y, 0.07), 'amber_deep', sides=4) if stage == 3 else None


def wheat(stage):
    if stage == 0:
        return sprout('leaf_light', 0.9)
    count, h = [(0, 0), (5, 0.28), (9, 0.5), (11, 0.74)][stage]
    for i, (a, r) in enumerate(ring(count, 0.15, 0.2, 0.5, 4)):
        x, y = r * math.cos(a), r * math.sin(a)
        hh = h * (0.85 + 0.3 * hash01(i, 9))
        top = (x * 1.2, y * 1.2, hh)
        if stage == 1:
            leaf((x, y, 0), (x * 1.8, y * 1.8, hh), 0.35, 'leaf_light', lift=0.2)
            continue
        tube((x, y, 0), top, 0.012, 'leaf' if stage == 2 else 'wheat_dark', sides=3)
        head = 'leaf_light' if stage == 2 else 'wheat'
        lathe([(0, -0.02), (0.032, 0.02), (0.026, 0.12), (0, 0.19)], 4, top, color=head)
        if stage == 3 and i % 3 == 0:
            leaf((x, y, 0.1), (x * 1.9, y * 1.9, 0.3), 0.25, 'leaf', lift=0.2)


def clover(stage):
    if stage == 0:
        return sprout('leaf_light', 0.8)
    n, size, blooms = [(0, 0, 0), (3, 0.5, 0), (5, 0.8, 2), (6, 1.0, 4)][stage]
    for i, (a, r) in enumerate(ring(n, 0.17 * size + 0.02, 0.3, 0.25, 8)):
        x, y = r * math.cos(a), r * math.sin(a)
        z = 0.05 + 0.03 * hash01(i, 2)
        for k in range(3):
            b = a + k * 2.094 + 0.5
            ln = 0.15 * size + 0.04
            leaf((x, y, z), (x + ln * math.cos(b), y + ln * math.sin(b), z + 0.02), 0.95, 'leaf' if i % 2 else 'leaf_dark', lift=0.25)
    for i, (a, r) in enumerate(ring(blooms, 0.16, 1.0, 0.2, 3)):
        x, y = r * math.cos(a), r * math.sin(a)
        tube((x, y, 0), (x, y, 0.22 + 0.04 * (i % 2)), 0.01, 'leaf_dark', sides=3)
        ico(0.052, (x, y, 0.25 + 0.04 * (i % 2)), 'pink', scale=(1, 1, 0.9), subdiv=1, jitter=0.12, seed=i)
        gem(0.02, (x, y, 0.3 + 0.04 * (i % 2)), 'cream', sides=4)


def pumpkin_body(r, loc, color='pumpkin', rib=0.0, seed=0):
    lathe([(0, 0), (r * 0.62, 0.01), (r * 0.98, r * 0.4), (r, r * 0.8), (r * 0.78, r * 1.18), (r * 0.3, r * 1.34), (0, r * 1.28)],
          8, loc, color=color, phase=0.2)


def pumpkin(stage):
    if stage == 0:
        return sprout('leaf', 0.8)
    r = [0, 0.07, 0.13, 0.2][stage]
    col = ['', 'leaf_light', 'amber_deep', 'pumpkin'][stage]
    pumpkin_body(r, (0.04, -0.04, 0.0), col)
    cyl(0.03 + 0.01 * stage, 0.06 + 0.03 * stage, (0.04, -0.04, r * 1.28 - 0.01), 'leaf_dark', sides=5, r2=0.02)
    for a, ln in [(2.4, 0.2 + 0.06 * stage), (3.6, 0.18 + 0.05 * stage), (0.9 if stage > 1 else 1.4, 0.16 + 0.05 * stage)]:
        leaf((-0.05, 0.05, 0.03), (-0.05 + ln * math.cos(a), 0.05 + ln * math.sin(a), 0.1 + 0.04 * stage), 0.8, 'leaf', lift=0.25, droop=0.03)
    if stage >= 2:
        tube((-0.04, 0.05, 0.02), (0.04, -0.04, r * 0.2), 0.012, 'leaf_dark', sides=3)
    if stage == 3:
        pumpkin_body(0.09, (-0.2, 0.2, 0.0), 'pumpkin')
        cyl(0.02, 0.05, (-0.2, 0.2, 0.11), 'leaf_dark', sides=4, r2=0.014)


def berry(stage):
    if stage == 0:
        return sprout('leaf', 0.8)
    s = [0, 0.5, 0.8, 1.0][stage]
    ico(0.2 * s, (0, 0, 0.2 * s), 'leaf_dark', scale=(1.2, 1.1, 0.9), subdiv=1, jitter=0.12, seed=3)
    ico(0.15 * s, (0.14 * s, -0.08 * s, 0.17 * s), 'leaf', jitter=0.15, seed=4)
    ico(0.14 * s, (-0.15 * s, 0.07 * s, 0.17 * s), 'leaf_light', jitter=0.15, seed=5)
    if stage >= 2:
        for i, (a, r) in enumerate(ring(5 if stage == 2 else 10, 0.2 * s, 0.4, 0.15, 6)):
            gem(0.034 if stage == 2 else 0.04, (r * math.cos(a), r * math.sin(a) * 0.9, 0.12 + 0.2 * s * hash01(i, 8)),
                'plum' if stage == 2 else 'berry')


def apple(stage):
    if stage == 0:
        return sprout('leaf', 0.8)
    s = [0, 0.4, 0.7, 1.0][stage]
    cyl(0.04 + 0.02 * s, 0.14 + 0.2 * s, (0, 0, 0), 'wood_dark', sides=5, r2=0.025 + 0.015 * s)
    top = 0.14 + 0.2 * s
    ico(0.15 + 0.15 * s, (0, 0, top + 0.1 + 0.08 * s), 'leaf' if stage < 3 else 'leaf_dark', scale=(1, 1, 0.92), subdiv=1, jitter=0.12, seed=5)
    if stage >= 2:
        ico(0.1 + 0.08 * s, (0.13 * s, -0.06 * s, top + 0.06 * s), 'leaf_light', jitter=0.15, seed=6)
        ico(0.1 + 0.08 * s, (-0.13 * s, 0.05 * s, top + 0.05 * s), 'leaf', jitter=0.15, seed=7)
    if stage == 3:
        for i, (a, r) in enumerate(ring(6, 0.24, 0.5, 0.12, 2)):
            gem(0.042, (r * math.cos(a), r * math.sin(a), top + 0.07 + 0.2 * hash01(i, 3)), 'apple', sides=5)


def item_honey():
    lathe([(0, 0), (0.06, 0), (0.07, 0.03), (0.07, 0.1), (0.05, 0.12)], 8, color='honey')
    cyl(0.055, 0.03, (0, 0, 0.12), 'wood', sides=8)
    block(-0.071, 0.071, -0.01, 0.01, 0.04, 0.09, 'cream', taper=1.0)
    gem(0.02, (0, -0.012, 0.065), 'amber_deep', sides=4)


def item_compost():
    lathe([(0, 0), (0.07, 0.0), (0.095, 0.05), (0.075, 0.11), (0.03, 0.15), (0.0, 0.14)], 7, color='wood')
    cyl(0.035, 0.03, (0, 0, 0.13), 'leaf_dark', sides=5, r2=0.02)
    leaf((0, 0, 0.16), (0.07, 0.03, 0.2), 0.6, 'leaf_light')
    leaf((0, 0, 0.16), (-0.06, -0.04, 0.2), 0.6, 'leaf')


BUILDS = {}
for _kind, _fn in [('carrot', carrot), ('wheat', wheat), ('clover', clover), ('pumpkin', pumpkin), ('berry', berry), ('apple', apple)]:
    for _s in range(4):
        BUILDS[f'crop_{_kind}_s{_s}'] = ('crop', (lambda fn, s: lambda: fn(s))(_fn, _s))
BUILDS['item_honey'] = ('prop', grounded(item_honey, 0.25, 0.25))
BUILDS['item_compost'] = ('prop', grounded(item_compost, 0.25, 0.3))

if __name__ == '__main__':
    common.build(BUILDS)
