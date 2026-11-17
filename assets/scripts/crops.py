"""AC: twenty tile-centred, flat-shaded crop stages, all <=300 triangles.

Run with Blender's factory-startup headless process; common owns export/render.
Geometry uses closed folded leaves, economical stems and faceted fruit rather
than subdivided foliage spheres. All coordinates are authored in world space,
so every mesh (and the joined export) has its origin at ground/tile centre.
"""
import math
import os
import sys
from functools import partial

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
import common
import bpy
from mathutils import Vector


def mesh(label, vertices, faces, colors):
    """Create a closed, palette-only mesh with optional per-face shading."""
    data = bpy.data.meshes.new(label)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(label, data)
    bpy.context.collection.objects.link(obj)
    names = [colors] if isinstance(colors, str) else list(dict.fromkeys(colors))
    for name in names:
        data.materials.append(common.mat(name))
    if not isinstance(colors, str):
        for face, name in zip(data.polygons, colors):
            face.material_index = names.index(name)
    return obj


def stem(start, end, radius=0.009, color='leaf_dark', taper=0.72):
    """Four-sided skew prism, horizontal end rings: 12 triangles, z-safe base."""
    vertices = []
    for point, r in ((start, radius), (end, radius * taper)):
        for x, y in ((1, 0), (0, 1), (-1, 0), (0, -1)):
            vertices.append((point[0] + x * r, point[1] + y * r, point[2]))
    faces = [(3, 2, 1, 0), (4, 5, 6, 7)]
    faces += [(i, (i + 1) % 4, (i + 1) % 4 + 4, i + 4) for i in range(4)]
    return mesh('stem', vertices, faces, color)


KITE = [(0, 0), (-1, 0.43), (0, 1), (1, 0.43)]
FERN = [(0, 0), (-0.68, 0.18), (-1, 0.30), (-0.40, 0.42),
        (-0.88, 0.55), (-0.30, 0.67), (-0.60, 0.80), (0, 1),
        (0.60, 0.80), (0.30, 0.67), (0.88, 0.55), (0.40, 0.42),
        (1, 0.30), (0.68, 0.18)]
HEART = [(0, 0), (-0.75, 0.45), (-1, 0.78), (-0.55, 1),
         (0, 0.87), (0.55, 1), (1, 0.78), (0.75, 0.45)]
LOBED = [(0, 0), (-0.70, 0.24), (-0.48, 0.40), (-1, 0.55),
         (-0.44, 0.67), (-0.45, 0.85), (0, 1), (0.45, 0.85),
         (0.44, 0.67), (1, 0.55), (0.48, 0.40), (0.70, 0.24)]
EAR = [(0, 0), (-0.72, 0.14), (-0.35, 0.27), (-1, 0.36),
       (-0.32, 0.48), (-0.82, 0.57), (-0.25, 0.69), (-0.60, 0.77),
       (-0.20, 0.89), (0, 1), (0.20, 0.89), (0.60, 0.77),
       (0.25, 0.69), (0.82, 0.57), (0.32, 0.48), (1, 0.36),
       (0.35, 0.27), (0.72, 0.14)]


def leaf(start, end, width, color='leaf', shape=KITE, ridge=0.013,
         shade=None, side=None):
    """Closed outline with raised front/back midrib: 2 triangles per point."""
    start, end = Vector(start), Vector(end)
    axis = end - start
    if side is None:
        side = Vector((-axis.y, axis.x, 0))
        if side.length < 0.0001:
            side = Vector((1, 0, 0))
    else:
        side = Vector(side)
    side.normalize()
    normal = axis.cross(side).normalized()
    vertices = [start + axis * t + side * x * width for x, t in shape]
    middle = start + axis * 0.47
    vertices += [middle + normal * ridge, middle - normal * ridge * 0.35]
    n = len(shape)
    faces = []
    colors = []
    for i in range(n):
        j = (i + 1) % n
        faces.extend([(i, j, n), (j, i, n + 1)])
        colors.extend([shade if shade and i % 3 == 0 else color, color])
    return mesh('folded_leaf', vertices, faces, colors)


def polar(radius, angle, z):
    return Vector((radius * math.cos(angle), radius * math.sin(angle), z))


def seedling(kind, scale=1.0):
    top = (0, 0, 0.07 * scale)
    stem((0, 0, 0), top, 0.008 * scale)
    shape = HEART if kind == 'clover' else KITE
    color = 'clover' if kind == 'clover' else 'leaf_light'
    for sign in (-1, 1):
        leaf(top, (sign * 0.095 * scale, sign * 0.038 * scale, 0.15 * scale),
             0.035 * scale, color, shape=shape, ridge=0.008 * scale)


def carrot_root(radius, height):
    """Tapered exposed orange shoulder; the root tip terminates at ground."""
    vertices = [(0, 0, 0)]
    for z, r in ((height * 0.48, radius), (height * 0.82, radius * 0.86)):
        for i in range(8):
            a = i * math.tau / 8
            vertices.append((r * math.cos(a), r * math.sin(a), z))
    vertices.append((0, 0, height))
    faces, colors = [], []
    for i in range(8):
        j = (i + 1) % 8
        faces.extend([(0, 1 + j, 1 + i), (1 + i, 1 + j, 9 + j, 9 + i),
                      (9 + i, 9 + j, 17)])
        colors.extend(['carrot', 'carrot', 'honey' if i % 3 == 0 else 'carrot'])
    mesh('orange_root_shoulder', vertices, faces, colors)


def carrot(stage):
    if stage == 0:
        seedling('carrot')
        return
    height = (0, 0.075, 0.125, 0.18)[stage]
    carrot_root((0, 0.052, 0.084, 0.115)[stage], height)
    count = (0, 3, 5, 6)[stage]
    reach = (0, 0.135, 0.215, 0.33)[stage]
    for i in range(count):
        a = i * math.tau / count + 0.20
        start = polar(0.008, a, height * 0.91)
        joint = polar(0.036, a, height + 0.055)
        stem(start, joint, 0.007 + stage * 0.001)
        tip = polar(reach, a, (0, 0.32, 0.49, 0.67)[stage] - 0.035 * (i % 2))
        leaf(joint, tip, (0, 0.041, 0.058, 0.085)[stage],
             'leaf' if i % 2 else 'leaf_light', shape=FERN,
             ridge=0.012, shade='leaf_dark')


def wheat(stage):
    if stage == 0:
        for i in range(3):
            a = i * math.tau / 3 + 0.3
            leaf((0, 0, 0), polar(0.09, a, 0.19 - i * 0.02),
                 0.017, 'leaf_light', ridge=0.005)
        return
    count = 6 if stage == 3 else 5
    for i in range(count):
        a = i * math.tau / count + 0.25
        r = (0, 0.073, 0.10, 0.125)[stage]
        base = polar(r, a, 0)
        h = (0, 0.30, 0.53, 0.70)[stage] + (0, 0.012, 0.019, 0.023)[stage] * i
        top = polar(r * 1.25, a, h)
        stem(base, top, 0.009, 'wheat' if stage == 3 else 'leaf_dark')
        leaf(base.lerp(top, 0.36), polar((0, 0.17, 0.235, 0.285)[stage], a, h * 0.76),
             (0, 0.025, 0.026, 0.029)[stage],
             'wheat' if stage == 3 and i % 2 == 0 else 'leaf', ridge=0.006)
        if stage >= 2:
            tip = top + Vector((0.018 * math.cos(a), 0.018 * math.sin(a),
                                0.13 if stage == 2 else 0.245))
            leaf(top, tip, 0.032 if stage == 2 else 0.057,
                 'wheat', shape=EAR if stage == 2 else FERN, ridge=0.015,
                 shade='leaf_light' if stage == 2 else 'accent', side=(0.707, 0.707, 0))


def clover_flower(point):
    """An eight-point pale scalloped crown; 16 triangles, not a sphere."""
    x, y, z = point
    vertices = []
    for i in range(8):
        a = i * math.tau / 8
        r = 0.046 if i % 2 == 0 else 0.029
        vertices.append((x + r * math.cos(a), y + r * math.sin(a), z))
    vertices += [(x, y, z + 0.032), (x, y, z - 0.020)]
    faces = []
    for i in range(8):
        j = (i + 1) % 8
        faces.extend([(i, j, 8), (j, i, 9)])
    mesh('clover_flower_crown', vertices, faces, 'clover_flower')


def clover(stage):
    if stage == 0:
        seedling('clover', 0.85)
        return
    count = stage + 1
    spread = (0, 0.055, 0.095, 0.14)[stage]
    length = (0, 0.10, 0.13, 0.158)[stage]
    height = (0, 0.14, 0.17, 0.225)[stage]
    for i in range(count):
        a = i * math.tau / count + math.pi / 4
        base = polar(spread * 0.45, a, 0)
        hub = polar(spread, a, height * 0.68)
        stem(base, hub, 0.008)
        for j in range(3):
            angle = a + j * math.tau / 3
            tip = hub + polar(length, angle, height * 0.30)
            leaf(hub, tip, length * 0.46, 'clover' if j != 1 else 'leaf_light',
                 shape=HEART, ridge=0.008, shade='leaf')
    if stage >= 2:
        for i in range(stage - 1):
            sign = -1 if i == 0 else 1
            base = (sign * spread * 0.70, -sign * spread * 0.40, 0)
            top = (base[0], base[1], height + 0.07)
            stem(base, top, 0.006)
            clover_flower(top)


def vine(points, radius=0.012):
    """Continuous square-section creeping vine, 8 tris/segment + 4 end tris."""
    vertices = []
    for i, point in enumerate(points):
        direction = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(0, i - 1)])
        side = Vector((-direction.y, direction.x, 0)).normalized() * radius
        p = Vector(point)
        vertices.extend([p + side + Vector((0, 0, radius)),
                         p - side + Vector((0, 0, radius)),
                         p - side - Vector((0, 0, radius)),
                         p + side - Vector((0, 0, radius))])
    faces = [(3, 2, 1, 0)]
    for k in range(len(points) - 1):
        for i in range(4):
            j = (i + 1) % 4
            faces.append((4 * k + i, 4 * k + j, 4 * (k + 1) + j, 4 * (k + 1) + i))
    last = 4 * (len(points) - 1)
    faces.append(tuple(last + i for i in range(4)))
    mesh('creeping_vine', vertices, faces, 'leaf_dark')


def pumpkin_fruit(center, radius, height):
    """Six readable ribs: alternating twelve-sector radii, four profile rings."""
    x, y = center
    vertices = [(x, y, 0)]
    profile = [(0.10, 0.53), (0.39, 1), (0.76, 0.91), (0.96, 0.37)]
    for z, r in profile:
        for i in range(12):
            a = i * math.tau / 12
            lobe = 1 if i % 2 == 0 else 0.80
            vertices.append((x + radius * r * lobe * math.cos(a),
                             y + radius * r * lobe * math.sin(a), height * z))
    vertices.append((x, y, height))
    faces, colors = [], []
    for i in range(12):
        j = (i + 1) % 12
        faces.append((0, 1 + j, 1 + i))
        colors.append('pumpkin')
        for ring in range(3):
            lo, hi = 1 + ring * 12, 1 + (ring + 1) * 12
            faces.append((lo + i, lo + j, hi + j, hi + i))
            colors.append('carrot' if i % 2 == 0 else 'pumpkin')
        faces.append((37 + i, 37 + j, 49))
        colors.append('pumpkin')
    mesh('six_lobed_pumpkin', vertices, faces, colors)
    stem((x, y, height), (x + 0.023, y + 0.009, height + 0.047),
         0.018, 'wood_dark')


def pumpkin(stage):
    if stage == 0:
        seedling('pumpkin', 1.08)
        return
    extent = (0, 0.15, 0.225, 0.30)[stage]
    points = [(-extent, 0.075, 0.012), (0, 0.04, 0.012), (extent, 0.10, 0.012)]
    if stage == 3:
        points.insert(2, (0.14, 0.14, 0.012))
    vine(points)
    angles = [math.radians(a) for a in (155, 35, 95, 215)]
    count = (0, 3, 3, 4)[stage]
    for i, a in enumerate(angles[:count]):
        base = polar(extent * 0.37, a, 0.024)
        joint = polar(extent * 0.53, a, (0, 0.09, 0.09, 0.125)[stage])
        # All petioles share the vine's centre, rather than floating leaf blobs.
        stem((base.x, 0.04, 0.012), joint, 0.009)
        tip = joint + polar((0, 0.13, 0.16, 0.19)[stage], a,
                            (0, 0.095, 0.088, 0.10)[stage])
        leaf(joint, tip, (0, 0.060, 0.075, 0.090)[stage],
             'leaf' if i % 2 else 'leaf_dark', shape=LOBED, ridge=0.014, shade='leaf_light')
    if stage >= 2:
        pumpkin_fruit((0.025, -0.075), 0.11 if stage == 2 else 0.19,
                      0.185 if stage == 2 else 0.30)


def berry_cluster(center, radius):
    """Three touching octahedral berries (24 tris), visibly hung on a branch."""
    center = Vector(center)
    vertices, faces = [], []
    offsets = [(-0.70, 0, 0.12), (0.70, 0, 0.12), (0, -0.22, -0.94)]
    for offset in offsets:
        p = center + Vector(offset) * radius
        first = len(vertices)
        vertices += [p + Vector((radius, 0, 0)), p + Vector((0, radius, 0)),
                     p + Vector((-radius, 0, 0)), p + Vector((0, -radius, 0)),
                     p + Vector((0, 0, radius)), p + Vector((0, 0, -radius))]
        for i in range(4):
            j = (i + 1) % 4
            faces.extend([(first + i, first + j, first + 4),
                          (first + j, first + i, first + 5)])
    mesh('hanging_magenta_berry_cluster', vertices, faces, 'berry')


def berry(stage):
    if stage == 0:
        seedling('berry', 1.05)
        return
    height = (0, 0.18, 0.275, 0.35)[stage]
    trunk_top = Vector((0, 0, height))
    stem((0, 0, 0), trunk_top, 0.014 + stage * 0.002, 'wood_dark')
    count = 3 if stage == 1 else 4
    reach = (0, 0.095, 0.145, 0.185)[stage]
    length = (0, 0.105, 0.145, 0.18)[stage]
    for i in range(count):
        a = i * math.tau / count + math.pi / 4
        start = trunk_top * 0.52
        end = polar(reach, a, height + 0.035 * (i % 2))
        stem(start, end, 0.011, 'wood')
        joint = start.lerp(end, 0.57)
        leaf(joint, joint + polar(length, a - 0.45, 0.075),
             length * (0.49 if stage == 3 else 0.36), 'leaf_dark', ridge=0.014, shade='leaf')
        leaf(end, end + polar(length, a + 0.25, 0.07),
             length * (0.54 if stage == 3 else 0.39), 'leaf', ridge=0.014, shade='leaf_light')
        if stage == 3:
            leaf(end, end + polar(length * 0.85, a + 1.3, 0.13),
                 length * 0.48, 'leaf_light', ridge=0.012, shade='leaf')
        if stage >= 2 and (stage == 3 or i % 2 == 0):
            berry_cluster(end + Vector((0.010, -0.015, -0.047)),
                          0.029 if stage == 2 else 0.038)
    if stage >= 2:
        for sign in (-1, 1):
            leaf(trunk_top, trunk_top + Vector((sign * (0.14 if stage == 3 else 0.065),
                                               0.014, length * 1.28)),
                 length * (0.40 if stage == 3 else 0.26), 'leaf',
                 ridge=0.012, shade='leaf_light')


def checked(builder, stage):
    # Use a reproducible neutral studio preset for the common workbench render.
    # Materials themselves remain untouched shared-palette materials.
    bpy.context.scene.view_settings.view_transform = 'Standard'
    bpy.context.scene.view_settings.look = 'None'
    bpy.context.scene.display.shading.studio_light = 'paint.sl'
    builder(stage)
    vertices = [obj.matrix_world @ v.co for obj in bpy.context.scene.objects
                if obj.type == 'MESH' for v in obj.data.vertices]
    assert vertices
    for axis in (0, 1):
        lo = min(v[axis] for v in vertices)
        hi = max(v[axis] for v in vertices)
        assert -0.425 <= lo <= hi <= 0.425, (builder.__name__, stage, axis, lo, hi)
        assert hi - lo <= 0.85
    assert abs(min(v.z for v in vertices)) < 1e-6, (builder.__name__, stage, 'ground')
    assert all(v.z >= -1e-6 for v in vertices), (builder.__name__, stage, 'below ground')
    assert all(obj.location.length == 0 for obj in bpy.context.scene.objects if obj.type == 'MESH')


BUILDERS = {'carrot': carrot, 'wheat': wheat, 'clover': clover,
            'pumpkin': pumpkin, 'berry': berry}
TABLE = {f'crop_{kind}_s{stage}': ('crop', partial(checked, builder, stage))
         for kind, builder in BUILDERS.items() for stage in range(4)}
assert len(TABLE) == 20

if __name__ == '__main__':
    common.build(TABLE)
