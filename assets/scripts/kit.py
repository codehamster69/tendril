"""Low-poly modelling kit for the "living floating island" art direction.

Every primitive computes world-space vertices in Python and creates one mesh object with identity transform, so
common.finalize can join them without origin surprises. Blender Z-up, 1 unit = 1 tile, -Y is the model's front.
All geometry is deterministic: jitter uses a seeded integer hash, never random().
"""
import math
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
import bmesh
from mathutils import Euler, Vector

import common


def _xf(points, loc, rot, scale):
    m = Euler(tuple(math.radians(a) for a in rot), 'XYZ').to_matrix()
    out = []
    for p in points:
        v = Vector((p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]))
        v = m @ v
        out.append((v.x + loc[0], v.y + loc[1], v.z + loc[2]))
    return out


def poly(name, verts, faces, color):
    """faces: list of index tuples. color: palette name, or list of names with one per face via (idx, name) pairs."""
    data = bpy.data.meshes.new(name)
    if faces and isinstance(faces[0], tuple) and len(faces[0]) == 2 and isinstance(faces[0][1], str):
        names = []
        plain = []
        for f, c in faces:
            plain.append(f)
            if c not in names:
                names.append(c)
        data.from_pydata(verts, [], plain)
        for c in names:
            data.materials.append(common.mat(c))
        for poly_, (_, c) in zip(data.polygons, faces):
            poly_.material_index = names.index(c)
    else:
        data.from_pydata(verts, [], faces)
        data.materials.append(common.mat(color))
    data.update()
    if len(data.polygons) >= 4:
        bm = bmesh.new()
        bm.from_mesh(data)
        if all(len(e.link_faces) == 2 for e in bm.edges):
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(data)
        bm.free()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return obj


def hash01(*ints):
    h = 2166136261
    for i in ints:
        h = ((h ^ (int(i) & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    return (h & 0xFFFF) / 65535.0


def lathe(profile, sides=8, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), color='white', twist=0.0, phase=0.0):
    """Revolve [(radius, z)] or [(radius, z, colour_of_segment_ending_here)]. Radius 0 collapses to an apex.
    Open end rings with radius > 0 are capped (bottom with the first colour, top with the colour of the last pt)."""
    rings = []
    verts = []
    cols = []
    for pr in profile:
        r, z = pr[0], pr[1]
        cols.append(pr[2] if len(pr) > 2 else color)
        if r <= 1e-9:
            rings.append([len(verts)])
            verts.append((0.0, 0.0, z))
        else:
            ring = []
            ang = phase + math.radians(twist) * z
            for i in range(sides):
                a = ang + 2 * math.pi * i / sides
                ring.append(len(verts))
                verts.append((r * math.cos(a), r * math.sin(a), z))
            rings.append(ring)
    faces = []
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        c = cols[k + 1]
        for i in range(sides):
            j = (i + 1) % sides
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                faces.append(((a[0], b[j], b[i]), c))
            elif len(b) == 1:
                faces.append(((a[i], a[j], b[0]), c))
            else:
                faces.append(((a[i], a[j], b[j], b[i]), c))
    if len(rings[0]) > 1:
        faces.append((tuple(reversed(rings[0])), cols[0]))
    if len(rings[-1]) > 1:
        faces.append((tuple(rings[-1]), cols[-1]))
    return poly('lathe', _xf(verts, loc, rot, scale), faces, color)


def cyl(r, h, loc=(0, 0, 0), color='white', sides=8, r2=None, rot=(0, 0, 0), scale=(1, 1, 1), phase=0.0):
    """Cylinder/frustum standing on loc (base centre)."""
    return lathe([(r, 0), (r if r2 is None else r2, h)], sides, loc, rot, scale, color, phase=phase)


def cone(r, h, loc=(0, 0, 0), color='white', sides=6, rot=(0, 0, 0), scale=(1, 1, 1), phase=0.0):
    return lathe([(r, 0), (0, h)], sides, loc, rot, scale, color, phase=phase)


def box(size, loc=(0, 0, 0), color='white', taper=1.0, rot=(0, 0, 0), centre=False, tcolor=None):
    """Box (sx, sy, sz) with base centre at loc (or centre when centre=True). taper scales the top face.
    tcolor paints the top face separately."""
    sx, sy, sz = size
    z0 = -sz / 2 if centre else 0
    b = [(-sx / 2, -sy / 2, z0), (sx / 2, -sy / 2, z0), (sx / 2, sy / 2, z0), (-sx / 2, sy / 2, z0)]
    t = [(x * taper, y * taper, z0 + sz) for x, y, _ in b]
    verts = b + t
    faces = [((0, 3, 2, 1), color), ((4, 5, 6, 7), tcolor or color), ((0, 1, 5, 4), color), ((1, 2, 6, 5), color),
             ((2, 3, 7, 6), color), ((3, 0, 4, 7), color)]
    return poly('box', _xf(verts, loc, rot, (1, 1, 1)), faces, color)


def block(x0, x1, y0, y1, z0, z1, color, taper=1.0, tcolor=None):
    return box((x1 - x0, y1 - y0, z1 - z0), ((x0 + x1) / 2, (y0 + y1) / 2, z0), color, taper, tcolor=tcolor)


def ico(r, loc=(0, 0, 0), color='white', scale=(1, 1, 1), subdiv=1, jitter=0.0, seed=0, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    pts = []
    for i, v in enumerate(bm.verts):
        p = v.co.copy()
        if jitter:
            f = 1 + jitter * (hash01(seed, i) * 2 - 1)
            p *= f
        pts.append((p.x, p.y, p.z))
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return poly('ico', _xf(pts, loc, rot, scale), faces, color)


def leaf(base, tip, width, color='leaf', lift=0.35, tcolor=None, droop=0.0):
    """Leaf blade from base to tip: 4 top triangles around a raised midrib, 2 underside triangles."""
    b, t = Vector(base), Vector(tip)
    d = t - b
    ln = d.length
    side = Vector((-d.y, d.x, 0))
    if side.length < 1e-6:
        side = Vector((1, 0, 0))
    side.normalize()
    mid = b + d * 0.45
    rib = mid + Vector((0, 0, ln * width * lift))
    tip2 = t - Vector((0, 0, droop))
    L, R = mid + side * width * ln / 2, mid - side * width * ln / 2
    verts = [tuple(b), tuple(L), tuple(rib), tuple(R), tuple(tip2), tuple(mid)]
    faces = [((0, 1, 2), tcolor or color), ((0, 2, 3), tcolor or color), ((1, 4, 2), color), ((3, 2, 4), color),
             ((0, 3, 5), color), ((3, 4, 5), color), ((4, 1, 5), color), ((1, 0, 5), color)]
    return poly('leaf', verts, faces, color)


def blade(base, tip, width, color='leaf', facing=0.0):
    """Single double-sided grass-like blade (2 triangles)."""
    b, t = Vector(base), Vector(tip)
    s = Vector((math.cos(facing), math.sin(facing), 0)) * width / 2
    verts = [tuple(b - s), tuple(b + s), tuple(t)]
    return poly('blade', verts, [(0, 1, 2), (0, 2, 1)], color)


def tube(a, b, r, color='wood', sides=5):
    a, b = Vector(a), Vector(b)
    d = b - a
    ln = d.length
    rot = d.to_track_quat('Z', 'Y').to_euler()
    return lathe([(r, 0), (r, ln)], sides, tuple(a), tuple(math.degrees(v) for v in rot), color=color)


def beam(a, b, w, h, color='wood'):
    """Rectangular bar from a to b (w across, h thick), not rotated about its own axis."""
    a, b = Vector(a), Vector(b)
    d = b - a
    ln = d.length
    q = d.to_track_quat('X', 'Z')
    pts = []
    for x in (0, ln):
        for y, z in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            v = q @ Vector((x, y, z))
            pts.append(tuple(a + v))
    faces = [((0, 3, 2, 1), color), ((4, 5, 6, 7), color), ((0, 1, 5, 4), color), ((1, 2, 6, 5), color),
             ((2, 3, 7, 6), color), ((3, 0, 4, 7), color)]
    return poly('beam', pts, faces, color)


def gable(x0, x1, y0, y1, z0, ridge, color, end_color=None, over=0.0, axis='x'):
    """Gable roof prism: eaves at z0 spanning the box, ridge at z0+ridge, running along `axis`."""
    ym = (y0 + y1) / 2
    verts = [(x0 - over, y0, z0), (x1 + over, y0, z0), (x1 + over, y1, z0), (x0 - over, y1, z0),
             (x0 - over, ym, z0 + ridge), (x1 + over, ym, z0 + ridge)]
    if axis == 'y':
        xm = (x0 + x1) / 2
        verts = [(x0, y0 - over, z0), (x1, y0 - over, z0), (x1, y1 + over, z0), (x0, y1 + over, z0),
                 (xm, y0 - over, z0 + ridge), (xm, y1 + over, z0 + ridge)]
        ec = end_color or color
        faces = [((0, 4, 5, 3), color), ((1, 2, 5, 4), color), ((0, 1, 4), ec), ((3, 5, 2), ec), ((0, 3, 2, 1), ec)]
        return poly('gable', verts, faces, color)
    ec = end_color or color
    faces = [((0, 1, 5, 4), color), ((3, 4, 5, 2), color), ((0, 4, 3), ec), ((1, 2, 5), ec), ((0, 3, 2, 1), ec)]
    return poly('gable', verts, faces, color)


def pyramid(sx, sy, h, loc, color, rot=(0, 0, 0)):
    verts = [(-sx / 2, -sy / 2, 0), (sx / 2, -sy / 2, 0), (sx / 2, sy / 2, 0), (-sx / 2, sy / 2, 0), (0, 0, h)]
    faces = [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return poly('pyramid', _xf(verts, loc, rot, (1, 1, 1)), faces, color)


def prepare_ground(footprint=None, height=None, tile=False):
    """Recentre XY on the footprint and drop the lowest point to z = 0 (tiles keep their authored placement)."""
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    pts = [v.co for o in meshes for v in o.data.vertices]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    if tile:
        assert abs(lo[2] + 0.2) < 1e-5 and hi[2] <= 0.12 and abs(lo[0] + 0.47) < 0.02 and abs(hi[0] - 0.47) < 0.02, (lo, hi)
        return
    off = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
    for o in meshes:
        for v in o.data.vertices:
            v.co += off
    size = [hi[i] - lo[i] for i in range(3)]
    if footprint is not None:
        assert max(size[0], size[1]) <= footprint + 1e-5, f'footprint {size}'
    if height is not None:
        assert size[2] <= height + 1e-5, f'height {size}'


def grounded(fn, footprint=None, height=None, tile=False):
    def run():
        fn()
        prepare_ground(footprint, height, tile)
    return run


def gem(r, loc, color, sides=5, scale=(1, 1, 1)):
    """Small bipyramid: berries, apples, buds. 2 * sides triangles."""
    return lathe([(0, -r), (r, 0), (0, r)], sides, loc, scale=scale, color=color)


def extrude(outline, z0, z1, color, loc=(0, 0, 0), rot=(0, 0, 0), tcolor=None):
    """Convex CCW XY outline extruded between z0 and z1."""
    n = len(outline)
    verts = [(x, y, z0) for x, y in outline] + [(x, y, z1) for x, y in outline]
    faces = [(tuple(reversed(range(n))), color), (tuple(range(n, 2 * n)), tcolor or color)]
    for i in range(n):
        j = (i + 1) % n
        faces.append(((i, j, n + j, n + i), color))
    return poly('extrude', _xf(verts, loc, rot, (1, 1, 1)), faces, color)
