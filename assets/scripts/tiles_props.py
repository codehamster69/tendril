"""AT's deterministic, palette-only terrain and farm props; headless Blender only."""
import math
import os
import sys

# Do not create shared helper bytecode during a parallel asset workstream.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import common
from common import cone, cube, cyl, mat, rotate, sphere


def box(size, loc, color, bevel=0.0):
    # common.cube applies its creation location as well as scale. Construct at
    # zero, then position, so rotations and local sculpting stay centre-relative.
    obj = cube(size, (0, 0, 0), color, bevel)
    obj.location = loc
    return obj


def mesh(name, vertices, faces, colors, indices=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    for color in colors:
        data.materials.append(mat(color))
    if indices is not None:
        for face, index in zip(data.polygons, indices):
            face.material_index = index
    return obj


def prism(name, outline, bottom, top, color, side=None):
    """Counterclockwise XY outline, with separate top/side palette materials."""
    n = len(outline)
    vertices = [(x, y, bottom) for x, y in outline]
    vertices += [(x, y, top) for x, y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    return mesh(name, vertices, faces, [color, side or color], [1, 0] + [1] * n)


def octagon(x, y, width, depth, cut):
    left, right = x - width / 2, x + width / 2
    front, back = y - depth / 2, y + depth / 2
    return [(left + cut, front), (right - cut, front),
            (right, front + cut), (right, back - cut),
            (right - cut, back), (left + cut, back),
            (left, back - cut), (left, front + cut)]


def masonry(x, width, bottom, top, color, number):
    """36-triangle stone: clipped corners, broad chisel bevel, inset square cap."""
    depth = 1.0
    cut = 0.015 + 0.002 * (number % 3)
    outline = octagon(x, 0, width, depth, cut)
    inset = 0.012
    cap = [(x - width / 2 + inset, -depth / 2 + inset),
           (x + width / 2 - inset, -depth / 2 + inset),
           (x + width / 2 - inset, depth / 2 - inset),
           (x - width / 2 + inset, depth / 2 - inset)]
    vertices = [(a, b, bottom) for a, b in outline]
    vertices += [(a, b, top - 0.012) for a, b in outline]
    vertices += [(a, b, top) for a, b in cap]
    faces = [tuple(reversed(range(8)))]
    faces += [(i, (i + 1) % 8, (i + 1) % 8 + 8, i + 8) for i in range(8)]
    # Four sloping bevel faces and four triangular clipped corners.
    faces += [(8, 9, 17, 16), (9, 10, 17),
              (10, 11, 18, 17), (11, 12, 18),
              (12, 13, 19, 18), (13, 14, 19),
              (14, 15, 16, 19), (15, 8, 16)]
    faces += [(16, 17, 18, 19)]
    return mesh('chiseled_stone', vertices, faces, [color, 'stone_dark'],
                [1] + [0] * 8 + [0] * 8 + [0])


def height_tile(name, xs, ys, height, surface_color):
    """Closed tile with a triangulated relief surface and shared perimeter skirt."""
    nx, ny = len(xs), len(ys)
    vertices = [(x, y, height(i, j)) for j, y in enumerate(ys) for i, x in enumerate(xs)]
    faces, indices = [], []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a, b = j * nx + i, j * nx + i + 1
            c, d = (j + 1) * nx + i + 1, (j + 1) * nx + i
            pair = [(a, b, c), (a, c, d)] if (i + j) % 2 else [(a, b, d), (b, c, d)]
            faces.extend(pair)
            indices.extend([surface_color(i, j, k) for k in range(2)])
    perimeter = list(range(nx))
    perimeter += [j * nx + nx - 1 for j in range(1, ny)]
    perimeter += [(ny - 1) * nx + i for i in range(nx - 2, -1, -1)]
    perimeter += [j * nx for j in range(ny - 2, 0, -1)]
    start = len(vertices)
    vertices += [(vertices[i][0], vertices[i][1], -0.2) for i in perimeter]
    for k, index in enumerate(perimeter):
        nxt = (k + 1) % len(perimeter)
        faces.append((index, start + k, start + nxt, perimeter[nxt]))
        indices.append(2)
    # Only four corners are needed to close the coplanar bottom.
    corners = [start, start + nx - 1, start + nx + ny - 2,
               start + 2 * nx + ny - 3]
    faces.append(tuple(reversed(corners)))
    indices.append(3)
    colors = ['grass', 'grass_dark', 'soil', 'soil_wet'] if name == 'grass' else ['soil', 'soil_wet', 'soil', 'soil_wet']
    if name == 'wet':
        colors = ['soil_wet', 'soil', 'soil_wet', 'soil_wet']
    return mesh(name + '_relief', vertices, faces, colors, indices)


def tile_grass():
    axis = [-0.5, -0.28, -0.03, 0.24, 0.5]

    def height(i, j):
        if i in (0, 4) or j in (0, 4):
            return 0.0
        return -0.004 - 0.010 * ((i * 3 + j * 5) % 7) / 6

    def color(i, j, triangle):
        return 1 if (i, j, triangle) in {(0, 2, 0), (0, 2, 1), (1, 2, 0), (3, 0, 1)} else 0

    height_tile('grass', axis, axis, height, color)


def soil_rows(wet=False):
    xs = [-0.5 + i * 0.05 for i in range(21)]
    ys = [-0.5, -0.18, 0.16, 0.5]
    profile = [-0.038, -0.008, 0.0, -0.008]

    def height(i, j):
        h = profile[i % 4]
        # Broken shoulders and gently crooked troughs, never above ground.
        if i % 4 != 2 and j in (1, 2):
            h -= (0.005 if wet else 0.003) * ((i + 2 * j) % 3)
        return h

    def color(i, j, triangle):
        if wet:
            return 1 if (i, j, triangle) in {(1, 1, 0), (9, 2, 1), (17, 0, 0)} else 0
        return 1 if i % 4 in (0, 3) else 0

    height_tile('wet' if wet else 'soil', xs, ys, height, color)


def tile_soil():
    soil_rows()


def tile_wet():
    # Damp earth, not a flooded blue tile: dark cultivated relief, three drying
    # facets, and tiny retained-water slivers occupying less than 1% of the tile.
    soil_rows(wet=True)
    for x, y, length in [(-0.3, -0.25, 0.19), (0.1, 0.19, 0.23), (0.3, -0.06, 0.15)]:
        outline = [(x - 0.007, y - length / 2), (x + 0.006, y - length / 2 + 0.025),
                   (x + 0.012, y + length / 4), (x + 0.004, y + length / 2),
                   (x - 0.009, y + length / 2 - 0.02), (x - 0.011, y - length / 5)]
        prism('retained_moisture', outline, -0.043, -0.028, 'water')


def tile_path():
    base = box((1, 1, 0.16), (0, 0, -0.12), 'soil')
    base.data.materials.append(mat('path'))
    for face in base.data.polygons:
        if face.normal.z > 0:
            face.material_index = 1
    stones = [(-0.17, -0.34, 0.28, 0.25, -7), (0.16, -0.31, 0.27, 0.27, 8),
              (-0.15, -0.015, 0.30, 0.28, 5), (0.18, 0.015, 0.26, 0.26, -9),
              (-0.18, 0.31, 0.28, 0.27, -8), (0.15, 0.34, 0.29, 0.25, 6)]
    for i, (x, y, width, depth, angle) in enumerate(stones):
        outline = octagon(0, 0, width, depth, 0.035 + 0.003 * (i % 2))
        obj = prism('stepping_stone', outline, -0.039, 0 if i % 2 else -0.003,
                    'stone' if i != 3 else 'path', 'stone_dark')
        obj.location.x, obj.location.y = x, y
        rotate(obj, z=angle)
    left = [(-0.5, -0.5), (-0.39, -0.5), (-0.35, -0.22), (-0.4, 0.08),
            (-0.36, 0.34), (-0.41, 0.5), (-0.5, 0.5)]
    right = [(-x, y) for x, y in reversed(left)]
    prism('grassy_verge', left, -0.04, -0.034, 'grass', 'grass_dark')
    prism('grassy_verge', right, -0.04, -0.034, 'grass_dark')


def tile_terrace_wall():
    # A unit terrain riser, not an above-ground freestanding wall: two staggered
    # courses and two capstones occupy precisely the contractual 20 cm depth.
    box((0.976, 0.976, 0.2), (0, 0, -0.1), 'stone_dark')
    # Recess the mortar core's top so the cap bevels remain visible.
    core = bpy.context.active_object
    for vertex in core.data.vertices:
        if vertex.co.z > 0:
            vertex.co.z -= 0.018
    for i in range(3):
        masonry((i - 1) * (1 / 3 + 0.002), (1 - 0.012) / 3,
                -0.2, -0.106, 'stone', i)
    for i, (x, width) in enumerate([(-0.3765, 0.247), (0, 0.494), (0.3765, 0.247)]):
        masonry(x, width, -0.107, -0.033, 'stone' if i != 1 else 'path', i + 3)
    masonry(-0.252, 0.496, -0.035, 0, 'stone', 6)
    masonry(0.252, 0.496, -0.035, 0, 'path', 7)


def panel(name, outline, front, depth, color, side='wood_dark'):
    """An XZ silhouette extruded along Y, useful for pickets and wooden arrows."""
    n = len(outline)
    vertices = [(x, front, z) for x, z in outline]
    vertices += [(x, front + depth, z) for x, z in outline]
    faces = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    faces += [(i, i + n, (i + 1) % n + n, (i + 1) % n) for i in range(n)]
    return mesh(name, vertices, faces, [color, side], [0, 1] + [1] * n)


def nail(x, y, z, radius=0.009):
    return rotate(cyl(radius, 0.008, (x, y, z), 'metal', verts=6), x=90)


def prop_fence():
    for x in (-0.43, 0.43):
        box((0.11, 0.12, 0.69), (x, 0.018, 0.345), 'wood', bevel=0.007)
        rotate(cone(0.083, 0.08, (x, 0.018, 0.73), 'wood_dark', verts=4), z=45)
        box((0.116, 0.126, 0.035), (x, 0.018, 0.635), 'wood_dark')
    for z in (0.235, 0.485):
        box((0.85, 0.058, 0.066), (0, 0.025, z), 'wood_dark', bevel=0.005)
    for i in range(5):
        x = -0.30 + i * 0.15
        top = 0.615 + (0.012 if i % 2 == 0 else 0)
        outline = [(x - 0.043, 0.065), (x + 0.043, 0.065),
                   (x + 0.043, top - 0.06), (x, top), (x - 0.043, top - 0.06)]
        panel('pointed_picket', outline, -0.052, 0.04, 'wood')
        for z in (0.235, 0.485):
            nail(x, -0.057, z, 0.007)


def prop_crate():
    box((0.62, 0.54, 0.035), (0, 0, 0.0175), 'wood_dark')
    for x in (-0.278, 0.278):
        for y in (-0.238, 0.238):
            box((0.055, 0.055, 0.52), (x, y, 0.2775), 'wood_dark', bevel=0.005)
    for i in range(5):
        box((0.102, 0.46, 0.025), (-0.216 + 0.108 * i, 0, 0.05), 'wood')
    for row in range(3):
        z = 0.125 + row * 0.142
        for y in (-0.254, 0.254):
            box((0.62, 0.032, 0.112), (0, y, z), 'wood', bevel=0.004)
        for x in (-0.294, 0.294):
            box((0.032, 0.475, 0.112), (x, 0, z), 'wood', bevel=0.004)
    for y in (-0.252, 0.252):
        box((0.62, 0.046, 0.052), (0, y, 0.522), 'wood', bevel=0.006)
    for x in (-0.287, 0.287):
        box((0.046, 0.46, 0.052), (x, 0, 0.522), 'wood', bevel=0.006)
    rotate(box((0.048, 0.026, 0.49), (0, -0.284, 0.287), 'wood_dark', bevel=0.003), y=-49)
    for x in (-0.257, 0.257):
        for y in (-0.275, 0.275):
            for z in (0.125, 0.409):
                nail(x, y, z)


def branch(start, end, radius):
    delta = Vector(end) - Vector(start)
    obj = cyl(radius, delta.length, (Vector(start) + Vector(end)) / 2,
              'wood', verts=7, r2=radius * 0.55)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def foliage_palette(obj, seed):
    for color in ('leaf_dark', 'leaf', 'leaf_light'):
        obj.data.materials.append(mat(color))
    # Existing first slot is preserved; modest palette facets, not confetti.
    for face in obj.data.polygons:
        if face.normal.z < -0.25:
            face.material_index = 1
        elif face.normal.z > 0.45 and (face.index + seed) % 4 == 0:
            face.material_index = 3


def prop_tree():
    cyl(0.112, 0.85, (0, 0, 0.425), 'wood', verts=7, r2=0.060)
    for angle in (20, 140, 260):
        a = math.radians(angle)
        dx, dy = math.cos(a), math.sin(a)
        side = (-dy * 0.038, dx * 0.038)
        mesh('root_flare', [(dx * 0.055 + side[0], dy * 0.055 + side[1], 0),
                            (dx * 0.055 - side[0], dy * 0.055 - side[1], 0),
                            (dx * 0.205, dy * 0.205, 0), (dx * 0.055, dy * 0.055, 0.24)],
             [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)], ['wood_dark'])
    for start, end, radius in [((0, 0, 0.58), (-0.22, -0.07, 1.02), 0.045),
                               ((0, 0, 0.66), (0.24, 0.08, 1.11), 0.037),
                               ((0, 0, 0.75), (-0.05, 0.22, 1.16), 0.031)]:
        branch(start, end, radius)
    crowns = [((-0.22, -0.075, 1.04), (0.29, 0.265, 0.29), 'leaf_dark'),
              ((0.235, 0.045, 1.115), (0.285, 0.28, 0.31), 'leaf'),
              ((-0.08, 0.22, 1.17), (0.31, 0.255, 0.32), 'leaf_dark'),
              ((0.015, -0.175, 1.245), (0.315, 0.26, 0.32), 'leaf'),
              ((-0.16, 0.025, 1.38), (0.27, 0.27, 0.29), 'leaf_light'),
              ((0.16, 0.145, 1.385), (0.265, 0.255, 0.275), 'leaf'),
              ((0.005, 0.025, 1.535), (0.24, 0.23, 0.245), 'leaf_light')]
    for i, (loc, scale, color) in enumerate(crowns):
        obj = sphere(1, (0, 0, 0), color, subdiv=2, scale=scale)
        obj.location = loc
        for vertex in obj.data.vertices:
            vertex.co *= 1 + 0.045 * math.sin(vertex.index * 2.399 + i)
        obj.data.update()
        foliage_palette(obj, i)


def grass_tuft(x, y, height):
    vertices, faces = [], []
    for i in range(3):
        a = i * 2.1
        dx, dy = math.cos(a), math.sin(a)
        k = len(vertices)
        vertices += [(x - dy * 0.015, y + dx * 0.015, 0),
                     (x + dy * 0.015, y - dx * 0.015, 0),
                     (x + dx * 0.035, y + dy * 0.035, height * (1 - i * 0.14))]
        faces.append((k, k + 1, k + 2))
    mesh('grass_blades', vertices, faces, ['grass_dark', 'grass'], [0, 1, 0])


def prop_rocks():
    stones = [((0.075, 0.095, 0.17), (0.255, 0.215, 0.27), 2),
              ((-0.24, -0.055, 0.11), (0.20, 0.18, 0.17), 2),
              ((0.25, -0.17, 0.095), (0.17, 0.145, 0.14), 2),
              ((-0.09, -0.275, 0.062), (0.115, 0.09, 0.09), 1),
              ((0.31, 0.22, 0.055), (0.105, 0.095, 0.082), 1),
              ((-0.29, 0.22, 0.042), (0.085, 0.07, 0.065), 1)]
    for i, (loc, scale, subdiv) in enumerate(stones):
        obj = sphere(1, (0, 0, 0), 'stone', subdiv=subdiv, scale=scale)
        obj.location = loc
        for vertex in obj.data.vertices:
            vertex.co.x *= 1 + 0.08 * math.sin(vertex.index * 1.7 + i)
            vertex.co.y *= 1 + 0.06 * math.cos(vertex.index * 2.3 + i)
            vertex.co.z = max(-loc[2], vertex.co.z)
        obj.data.update()
        obj.data.materials.append(mat('stone_dark'))
        for face in obj.data.polygons:
            if face.normal.z < 0.05 or (face.index + i) % 17 == 0:
                face.material_index = 1
    grass_tuft(-0.25, 0.12, 0.13)
    grass_tuft(0.14, -0.28, 0.11)


def prop_signpost():
    box((0.085, 0.085, 1.065), (0, 0.014, 0.5325), 'wood_dark', bevel=0.006)
    rotate(cone(0.061, 0.07, (0, 0.014, 1.10), 'wood', verts=4), z=45)
    box((0.106, 0.10, 0.055), (0, 0.014, 0.075), 'wood', bevel=0.004)
    upper = [(-0.32, 0.817), (0.18, 0.817), (0.32, 0.91),
             (0.18, 1.003), (-0.32, 1.003)]
    panel('right_arrow', upper, -0.06, 0.052, 'wood')
    lower = [(-0.31, 0.647), (-0.18, 0.555), (0.27, 0.555),
             (0.27, 0.739), (-0.18, 0.739)]
    panel('left_arrow', lower, -0.066, 0.048, 'wood', 'wood_dark')
    for z, front in ((0.86, -0.066), (0.96, -0.066), (0.60, -0.072), (0.69, -0.072)):
        nail(0, front, z, 0.009)
    # Incised-looking grain lines avoid unreadable typography at game scale.
    for x, z, width in [(-0.195, 0.866, 0.14), (-0.20, 0.949, 0.11),
                        (0.16, 0.60, 0.13), (0.15, 0.694, 0.16)]:
        rotate(box((width, 0.003, 0.008), (x, -0.071 if z > 0.8 else -0.077, z),
                    'wood_dark'), y=4)


def prepared(fn, tile=False):
    """Set every mesh origin to ground centre before common joins the meshes."""
    def build_asset():
        fn()
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        # Newly assigned transforms must be evaluated before measuring bounds.
        bpy.context.view_layer.update()
        points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
        lo = [min(v[i] for v in points) for i in range(3)]
        hi = [max(v[i] for v in points) for i in range(3)]
        if tile:
            assert all(abs(lo[i] + 0.5) < 1e-6 and abs(hi[i] - 0.5) < 1e-6 for i in (0, 1)), (lo, hi)
            assert abs(lo[2] + 0.2) < 1e-6 and abs(hi[2]) < 1e-6, (lo, hi)
        else:
            offset = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
            for obj in meshes:
                obj.location += offset
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes:
            # Flat palette assets have no textures; discard primitive UVs before
            # bevel evaluation to avoid unnecessary, rounding-sensitive UV data.
            while obj.data.uv_layers:
                obj.data.uv_layers.remove(obj.data.uv_layers[0])
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.context.scene.cursor.location = (0, 0, 0)
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        for obj in meshes:
            assert obj.location.length < 1e-6, obj.name
            assert all(material.name in common.PALETTE for material in obj.data.materials)
    return build_asset


if __name__ == '__main__':
    common.build({
        'tile_grass': ('tile', prepared(tile_grass, tile=True)),
        'tile_soil': ('tile', prepared(tile_soil, tile=True)),
        'tile_wet': ('tile', prepared(tile_wet, tile=True)),
        'tile_path': ('tile', prepared(tile_path, tile=True)),
        'tile_terrace_wall': ('tile', prepared(tile_terrace_wall, tile=True)),
        'prop_fence': ('prop', prepared(prop_fence)),
        'prop_crate': ('prop', prepared(prop_crate)),
        'prop_tree': ('prop', prepared(prop_tree)),
        'prop_rocks': ('prop', prepared(prop_rocks)),
        'prop_signpost': ('prop', prepared(prop_signpost)),
    })
