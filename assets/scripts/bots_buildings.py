"""AB's nine palette-only garden machines and farm buildings.

Run: blender -b --factory-startup -P assets/scripts/bots_buildings.py
Optional: -- --only bot_tender,prop_barn
"""
import math
import os
import sys
from functools import partial

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
from mathutils import Vector

import common
from common import cube, cyl, mat, paint, rotate, sphere


def mesh(name, vertices, faces, color):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return paint(obj, color)


def prism(name, profile, depth, color):
    """Extrude an X/Z outline along Y; profile is counterclockwise in X/Z."""
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(profile, profile[1:] + profile[:1]))
    if area < 0:
        profile = list(reversed(profile))
    vertices = [(x, depth[0], z) for x, z in profile]
    vertices += [(x, depth[1], z) for x, z in profile]
    n = len(profile)
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    faces += [(i, i + n, (i + 1) % n + n, (i + 1) % n) for i in range(n)]
    return mesh(name, vertices, faces, color)


def beam(a, b, width, color, depth=None):
    a, b = Vector(a), Vector(b)
    # common.cube bakes its location; rotate a zero-centred cube, then place it.
    obj = cube((width, depth or width, (b - a).length), (0, 0, 0), color)
    obj.location = (a + b) / 2
    obj.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()
    return obj


def pipe(a, b, radius, color, verts=8):
    a, b = Vector(a), Vector(b)
    obj = cyl(radius, (b - a).length, (a + b) / 2, color, verts)
    obj.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()
    return obj


def soft_box(size, loc, color, bevel, segments=1):
    obj = cube(size, loc, color, bevel)
    obj.modifiers['bevel'].segments = segments
    return obj


def leaf(a, b, width, color='leaf'):
    """Folded diamond, deliberately faceted rather than a smooth blob."""
    a, b = Vector(a), Vector(b)
    direction = b - a
    side = direction.cross(Vector((0, 0, 1)))
    if side.length < 0.001:
        side = Vector((1, 0, 0))
    side.normalize()
    middle = a + direction * 0.55
    vertices = [a, middle + side * width, b, middle - side * width,
                middle + Vector((0, 0, width * 0.45))]
    return mesh('folded_leaf', vertices,
                [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)], color)


def sprout(x, y, z, height=0.10):
    pipe((x, y, z), (x, y, z + height), 0.006, 'leaf_dark', 6)
    leaf((x, y, z + height * 0.55),
         (x - 0.060, y - 0.018, z + height * 0.88), 0.025, 'leaf')
    leaf((x, y, z + height * 0.68),
         (x + 0.055, y + 0.018, z + height), 0.023, 'leaf_light')


def track(x):
    radius, z, half_length = 0.080, 0.080, 0.106
    profile = []
    for center, start in ((-half_length, math.pi / 2), (half_length, -math.pi / 2)):
        for i in range(5):
            angle = start + math.pi * i / 4
            profile.append((center + radius * math.cos(angle), z + radius * math.sin(angle)))
    n = len(profile)
    vertices = [(side, y, zz) for side in (x - 0.034, x + 0.034) for y, zz in profile]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, n * 2))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    mesh('capsule_tread', vertices, faces, 'bot_dark')
    sign = 1 if x > 0 else -1
    for y in (-half_length, half_length):
        rotate(cyl(0.057, 0.014, (x + sign * 0.041, y, z), 'metal', 10), y=90)
        rotate(cyl(0.027, 0.018, (x + sign * 0.052, y, z), 'accent', 8), y=90)
    for y in (-0.09, 0, 0.09):
        cube((0.078, 0.025, 0.013), (x, y, 0.156), 'stone_dark')
    cube((0.078, 0.014, 0.025), (x, -0.184, 0.080), 'stone_dark')


def basket(loc, size, color='wood'):
    x, y, z = loc
    w, d, h = size
    cube((w, d, 0.018), (x, y, z + 0.009), 'wood_dark')
    for side in (-1, 1):
        cube((w, 0.018, h), (x, y + side * (d - 0.018) / 2, z + h / 2), color)
        cube((0.018, d - 0.036, h), (x + side * (w - 0.018) / 2, y, z + h / 2), color)
    cube((w - 0.036, d - 0.036, 0.016), (x, y, z + h - 0.025), 'soil_wet')


def spade():
    pipe((0.181, -0.015, 0.280), (0.246, -0.050, 0.355), 0.019, 'metal')
    sphere(0.026, (0.246, -0.05, 0.355), 'accent')
    pipe((0.246, -0.05, 0.355), (0.246, -0.145, 0.315), 0.012, 'wood_dark', 6)
    prism('spade_blade', [(0.209, 0.315), (0.283, 0.315),
                          (0.280, 0.265), (0.246, 0.245), (0.212, 0.265)],
          (-0.165, -0.151), 'metal')


def harvester():
    pipe((0.181, -0.015, 0.285), (0.235, -0.080, 0.335), 0.019, 'metal')
    sphere(0.025, (0.235, -0.080, 0.335), 'accent')
    beam((0.235, -0.080, 0.335), (0.240, -0.155, 0.310), 0.023, 'wood_dark')
    prism('sickle', [(0.204, 0.305), (0.244, 0.315), (0.287, 0.290),
                    (0.290, 0.252), (0.265, 0.232), (0.277, 0.272),
                    (0.239, 0.287), (0.209, 0.285)], (-0.168, -0.153), 'metal')


def tender(version=0):
    track(-0.213)
    track(0.213)
    soft_box((0.365, 0.338, 0.295), (0, -0.008, 0.302), 'bot_body', 0.071, 2)
    for x in (-0.191, 0.191):
        rotate(cyl(0.052, 0.047, (x, -0.007, 0.319), 'water', 10), y=90)
    soft_box((0.345, 0.315, 0.069), (0, 0.007, 0.464), 'water', 0.024)
    cube((0.325, 0.302, 0.024), (0, 0, 0.177), 'bot_dark')
    soft_box((0.306, 0.036, 0.173), (0, -0.179, 0.336), 'bot_light', 0.032)
    soft_box((0.277, 0.023, 0.145), (0, -0.201, 0.339), 'bot_dark', 0.027)
    for x in (-0.069, 0.069):
        soft_box((0.046, 0.018, 0.070), (x, -0.218, 0.356), 'bot_light', 0.018, 2)
        cube((0.023, 0.011, 0.010), (x * 1.25, -0.221, 0.312), 'accent')
    beam((-0.027, -0.222, 0.313), (0, -0.222, 0.305), 0.009, 'bot_light')
    beam((0, -0.222, 0.305), (0.027, -0.222, 0.313), 0.009, 'bot_light')
    for i in range(version + 1):
        cube((0.020, 0.012, 0.016), ((i - version / 2) * 0.028, -0.154, 0.463), 'accent')
    # Low-strength glow uses the existing palette material, never a new colour.
    light = mat('bot_light').node_tree.nodes['Principled BSDF']
    light.inputs['Emission Color'].default_value = (*common.PALETTE['bot_light'], 1)
    light.inputs['Emission Strength'].default_value = 0.28
    if version == 0:
        basket((0, 0.078, 0.499), (0.237, 0.175, 0.069))
        sprout(0, 0.079, 0.552, 0.105)
        spade()
    elif version == 1:
        cyl(0.098, 0.154, (0, 0.080, 0.569), 'water', 10)
        cyl(0.101, 0.017, (0, 0.080, 0.642), 'metal', 10)
        cyl(0.038, 0.021, (0, 0.080, 0.661), 'accent', 8)
        pipe((-0.072, 0.081, 0.615), (-0.121, 0.085, 0.633), 0.012, 'metal', 6)
        pipe((-0.121, 0.085, 0.633), (-0.130, 0.085, 0.567), 0.012, 'metal', 6)
        pipe((0.081, 0.080, 0.584), (0.228, -0.062, 0.533), 0.017, 'water')
        pipe((0.228, -0.062, 0.533), (0.247, -0.096, 0.522), 0.036, 'metal')
        spade()
    elif version == 2:
        basket((0, 0.077, 0.499), (0.249, 0.188, 0.107), 'honey')
        for x, y, z in ((-0.059, 0.061, 0.626), (0.007, 0.117, 0.638), (0.065, 0.065, 0.630)):
            cyl(0.027, 0.093, (x, y, z - 0.022), 'carrot', 6, r2=0.011)
            leaf((x, y, z + 0.016), (x - 0.034, y, z + 0.070), 0.017, 'leaf')
            leaf((x, y, z + 0.016), (x + 0.035, y + 0.013, z + 0.061), 0.016, 'leaf_light')
        harvester()
    else:
        basket((0, 0.070, 0.499), (0.224, 0.180, 0.065))
        sprout(-0.050, 0.033, 0.548, 0.084)
        sprout(0.046, 0.031, 0.548, 0.076)
        for x in (-0.108, 0.108):
            pipe((x, 0.124, 0.495), (x, 0.124, 0.658), 0.011, 'metal', 6)
        soft_box((0.325, 0.194, 0.022), (0, 0.106, 0.671), 'bot_dark', 0.008)
        for x in (-0.074, 0.074):
            for y in (0.064, 0.148):
                cube((0.134, 0.072, 0.006), (x, y, 0.685), 'water')
        pipe((-0.115, 0.140, 0.688), (-0.115, 0.140, 0.733), 0.008, 'metal', 6)
        sphere(0.019, (-0.115, 0.140, 0.750), 'accent')
        pipe((0.179, -0.012, 0.290), (0.246, -0.085, 0.349), 0.019, 'metal')
        sphere(0.027, (0.246, -0.085, 0.349), 'accent')
        beam((0.246, -0.085, 0.349), (0.246, -0.148, 0.322), 0.020, 'bot_dark')
        for x in (0.218, 0.274):
            beam((0.246, -0.148, 0.322), (x, -0.171, 0.299), 0.014, 'metal')
            beam((x, -0.171, 0.299), (x, -0.194, 0.321), 0.014, 'metal')


def gable_roof(half_width, half_depth, eave, ridge, color, thickness=0.025):
    for sign in (-1, 1):
        # Counterclockwise outlines give both slopes real thickness and outward normals.
        points = [(0, ridge), (sign * half_width, eave),
                  (sign * half_width, eave - thickness), (0, ridge - thickness)]
        if sign < 0:
            points.reverse()
        prism('roof_slope', points, (-half_depth, half_depth), color)
    cube((0.041, half_depth * 2 + 0.010, 0.026), (0, 0, ridge), color, 0.008)


def barn():
    cube((0.736, 0.692, 0.046), (0, 0, 0.023), 'wood_dark')
    cube((0.710, 0.670, 0.446), (0, 0, 0.257), 'red_dark')
    for i in range(8):
        x = (i - 3.5) * 0.090
        for y in (-0.341, 0.341):
            cube((0.082, 0.022, 0.444), (x, y, 0.264), 'red')
    for i in range(8):
        y = (i - 3.5) * 0.084
        for x in (-0.364, 0.364):
            cube((0.021, 0.077, 0.444), (x, y, 0.264), 'red')
    prism('gable_timbers', [(-0.374, 0.480), (0.374, 0.480), (0, 0.772)],
          (-0.352, 0.352), 'red')
    for y in (-0.365, 0.365):
        for sign in (-1, 1):
            beam((sign * 0.366, y, 0.487), (0, y, 0.773), 0.028, 'white')
        cube((0.748, 0.027, 0.028), (0, y, 0.480), 'white')
        beam((0, y, 0.491), (0, y, 0.736), 0.024, 'white')
    gable_roof(0.439, 0.416, 0.489, 0.811, 'bot_dark', 0.028)
    for x in (-0.360, 0.360):
        for y in (-0.343, 0.343):
            cube((0.031, 0.036, 0.478), (x, y, 0.239), 'white')
        side_x = math.copysign(0.392, x)
        cube((0.029, 0.655, 0.026), (side_x, 0, 0.097), 'white')
        beam((side_x, -0.302, 0.117), (side_x, 0.300, 0.424), 0.026, 'white')
    cube((0.355, 0.025, 0.352), (0, -0.365, 0.180), 'wood_dark')
    for x in (-0.083, 0.083):
        cube((0.157, 0.023, 0.329), (x, -0.383, 0.171), 'red_dark')
        for dx in (-0.051, 0, 0.051):
            cube((0.043, 0.010, 0.318), (x + dx, -0.398, 0.171), 'red')
        beam((x - 0.068, -0.408, 0.030), (x + 0.068, -0.408, 0.312), 0.016, 'white')
        beam((x + 0.068, -0.408, 0.030), (x - 0.068, -0.408, 0.312), 0.016, 'white')
        for z in (0.070, 0.273):
            cube((0.032, 0.011, 0.013), (x + math.copysign(0.063, x), -0.420, z), 'bot_dark')
        cube((0.011, 0.014, 0.035), (x - math.copysign(0.058, x), -0.419, 0.182), 'metal')
    for x in (-0.184, 0, 0.184):
        cube((0.024, 0.034, 0.353), (x, -0.398, 0.177), 'white')
    cube((0.392, 0.042, 0.026), (0, -0.394, 0.350), 'white')
    rotate(cyl(0.049, 0.016, (0, -0.369, 0.621), 'white', 12), x=90)
    rotate(cyl(0.033, 0.018, (0, -0.380, 0.621), 'bot_dark', 12), x=90)
    cube((0.010, 0.010, 0.067), (0, -0.392, 0.621), 'white')
    cube((0.067, 0.010, 0.010), (0, -0.392, 0.621), 'white')


def canopy_strip(x0, x1, color):
    lift = 0.12
    profile = [(y, z + lift) for y, z in [(-0.397, 0.661), (-0.245, 0.737),
                                        (-0.035, 0.801), (0.174, 0.790), (0.353, 0.689)]]
    vertices = [(x, y, z + dz) for dz in (0, -0.012) for x in (x0, x1) for y, z in profile]
    n = len(profile)
    faces = []
    for i in range(n - 1):
        faces += [(i, i + 1, n + i + 1, n + i),
                  (2 * n + i, 3 * n + i, 3 * n + i + 1, 2 * n + i + 1),
                  (i, 2 * n + i, 2 * n + i + 1, i + 1),
                  (n + i, n + i + 1, 3 * n + i + 1, 3 * n + i)]
    faces += [(0, n, 3 * n, 2 * n), (n - 1, 3 * n - 1, 4 * n - 1, 2 * n - 1)]
    mesh('canopy_stripe', vertices, [tuple(reversed(face)) for face in faces], color)
    prism('scalloped_valance', [(x, z + lift) for x, z in
                              [(x0, 0.664), (x0, 0.602), ((x0 + x1) / 2, 0.584),
                               (x1, 0.602), (x1, 0.664)]],
          (-0.406, -0.395), color)


def produce_crate(x, y, z, kind):
    basket((x, y, z), (0.205, 0.178, 0.079))
    for side in (-1, 1):
        cube((0.188, 0.009, 0.013), (x, y + side * 0.093, z + 0.031), 'wood_dark')
    for dx, dy in ((-0.049, -0.036), (0.042, -0.040), (0, 0.040)):
        if kind == 'carrot':
            cyl(0.023, 0.072, (x + dx, y + dy, z + 0.096), 'carrot', 6, r2=0.009)
            leaf((x + dx, y + dy, z + 0.130),
                 (x + dx + 0.026, y + dy, z + 0.167), 0.014)
        else:
            sphere(0.039, (x + dx, y + dy, z + 0.093), kind, scale=(1, 1, 0.85))
            pipe((x + dx, y + dy, z + 0.115), (x + dx, y + dy, z + 0.136), 0.007, 'leaf_dark', 6)


def market():
    for x in (-0.342, 0.342):
        for y in (-0.284, 0.277):
            cube((0.044, 0.044, 0.805), (x, y, 0.4025), 'wood_dark', 0.006)
            cube((0.065, 0.065, 0.037), (x, y, 0.0185), 'metal')
        beam((x, -0.264, 0.200), (x, 0.257, 0.729), 0.028, 'wood')
        cube((0.037, 0.603, 0.030), (x, -0.006, 0.735), 'wood')
    cube((0.731, 0.415, 0.040), (0, -0.080, 0.355), 'wood')
    cube((0.698, 0.040, 0.280), (0, -0.255, 0.195), 'wood_dark')
    for i in range(9):
        cube((0.069, 0.023, 0.267), ((i - 4) * 0.076, -0.285, 0.195), 'wood')
    cube((0.734, 0.025, 0.023), (0, -0.304, 0.087), 'wood_dark')
    cube((0.685, 0.164, 0.030), (0, 0.177, 0.427), 'wood')
    cube((0.717, 0.043, 0.028), (0, 0.277, 0.740), 'wood_dark')
    for i in range(8):
        canopy_strip(-0.432 + i * 0.108, -0.432 + (i + 1) * 0.108,
                     'red' if i % 2 == 0 else 'white')
    produce_crate(-0.233, -0.185, 0.375, 'carrot')
    produce_crate(0.003, -0.185, 0.375, 'berry')
    produce_crate(0.229, -0.185, 0.375, 'pumpkin')
    basket((-0.199, 0.173, 0.442), (0.224, 0.140, 0.110))
    basket((0.082, 0.172, 0.442), (0.235, 0.140, 0.097))
    # Small hanging price board: a grain motif, not unreadable miniature text.
    for x in (0.180, 0.306):
        pipe((x, -0.389, 0.732), (x, -0.389, 0.552), 0.005, 'bot_dark', 6)
    cube((0.194, 0.020, 0.074), (0.243, -0.389, 0.531), 'wood_dark', 0.006)
    cube((0.175, 0.007, 0.056), (0.243, -0.403, 0.531), 'accent')
    beam((0.207, -0.410, 0.511), (0.228, -0.410, 0.548), 0.007, 'wood_dark')
    for x, z in ((0.217, 0.532), (0.230, 0.540), (0.212, 0.545)):
        sphere(0.008, (x, -0.411, z), 'wood_dark', scale=(0.7, 0.35, 1.2))
    cube((0.033, 0.008, 0.006), (0.279, -0.411, 0.532), 'wood_dark')


def tank():
    for x in (-0.173, 0.173):
        for y in (-0.173, 0.173):
            cube((0.046, 0.046, 0.298), (x, y, 0.149), 'metal')
            cube((0.090, 0.087, 0.021), (x, y, 0.0105), 'bot_dark')
        beam((x, -0.166, 0.046), (x, 0.166, 0.252), 0.016, 'bot_dark')
    cyl(0.253, 0.405, (0, 0, 0.4785), 'metal', 12)
    cyl(0.255, 0.133, (0, 0, 0.475), 'water', 12)
    for z in (0.292, 0.668):
        cyl(0.265, 0.027, (0, 0, z), 'bot_dark', 12)
    cyl(0.253, 0.075, (0, 0, 0.7105), 'metal', 12, r2=0.123)
    cyl(0.071, 0.023, (0, 0, 0.7595), 'bot_dark', 10)
    cyl(0.060, 0.014, (0, 0, 0.778), 'metal', 10)
    cube((0.068, 0.017, 0.019), (0, 0, 0.793), 'accent', 0.004)
    pipe((0, -0.228, 0.327), (0, -0.341, 0.327), 0.024, 'metal')
    cyl(0.026, 0.071, (0, -0.341, 0.297), 'metal', 8)
    cyl(0.012, 0.055, (0, -0.288, 0.361), 'bot_dark', 8)
    pipe((-0.050, -0.288, 0.388), (0.050, -0.288, 0.388), 0.010, 'accent')
    cyl(0.019, 0.010, (0, -0.341, 0.259), 'bot_dark', 8)
    prism('water_drop_badge', [(-0.027, 0.469), (0, 0.515), (0.027, 0.469),
                               (0.024, 0.451), (0, 0.440), (-0.024, 0.451)],
          (-0.257, -0.251), 'white')
    cube((0.035, 0.017, 0.168), (0.144, -0.219, 0.536), 'bot_dark', 0.005)
    cube((0.020, 0.008, 0.144), (0.144, -0.232, 0.536), 'bot_light')
    for z in (0.488, 0.520, 0.552):
        cube((0.018, 0.010, 0.021), (0.144, -0.240, z), 'water')
    for y in (-0.100, 0.100):
        pipe((0.274, y, 0.218), (0.274, y, 0.702), 0.011, 'metal')
    for z in (0.264, 0.359, 0.454, 0.549, 0.644):
        pipe((0.277, -0.100, z), (0.277, 0.100, z), 0.012, 'metal')


def hive():
    for x in (-0.164, 0.164):
        for y in (-0.158, 0.158):
            cube((0.049, 0.049, 0.073), (x, y, 0.0365), 'wood_dark')
    cube((0.438, 0.416, 0.039), (0, 0, 0.0845), 'wood_dark')
    for i in range(3):
        z = 0.108 + i * 0.143
        cube((0.400, 0.382, 0.133), (0, 0, z + 0.0665), 'honey', 0.008)
        cube((0.406, 0.390, 0.014), (0, 0, z + 0.134), 'wood_dark')
        for y in (-0.197, 0.197):
            cube((0.106, 0.028, 0.025), (0, y, z + 0.083), 'wood')
            cube((0.357, 0.008, 0.007), (0, y, z + 0.033), 'wood')
        cube((0.026, 0.101, 0.023), (0.204, 0, z + 0.083), 'wood')
    cube((0.196, 0.012, 0.027), (0, -0.197, 0.128), 'black')
    cube((0.277, 0.118, 0.021), (0, -0.247, 0.1045), 'wood')
    prism('hive_gable', [(-0.202, 0.536), (0.202, 0.536), (0, 0.669)],
          (-0.193, 0.193), 'wood')
    gable_roof(0.267, 0.253, 0.537, 0.690, 'wood_dark', 0.025)
    for sign in (-1, 1):
        beam((sign * 0.258, -0.263, 0.541), (0, -0.263, 0.688), 0.019, 'wood')
    # A tiny bee emblem distinguishes the hive even at tile scale.
    sphere(0.029, (0.080, -0.212, 0.317), 'honey', scale=(1.2, 0.25, 0.75))
    cube((0.008, 0.018, 0.041), (0.080, -0.219, 0.317), 'bot_dark')
    sphere(0.022, (0.061, -0.215, 0.341), 'white', scale=(0.8, 0.25, 1))
    sphere(0.022, (0.098, -0.215, 0.341), 'white', scale=(0.8, 0.25, 1))


def compost():
    for x in (-0.274, 0.274):
        for y in (-0.269, 0.269):
            cube((0.058, 0.058, 0.494), (x, y, 0.247), 'wood_dark', 0.004)
    for i in range(5):
        z = 0.061 + i * 0.091
        cube((0.540, 0.031, 0.061), (0, 0.269, z), 'wood')
        for x in (-0.273, 0.273):
            cube((0.032, 0.514, 0.061), (x, 0, z), 'wood')
        if i < 3:
            cube((0.540, 0.031, 0.061), (0, -0.269, z), 'wood')
        else:
            for x in (-0.205, 0.205):
                cube((0.136, 0.031, 0.061), (x, -0.269, z), 'wood')
    cube((0.473, 0.467, 0.217), (0, 0, 0.1675), 'soil_wet')
    heights = [0.337, 0.361, 0.330, 0.373, 0.453, 0.384, 0.346, 0.395, 0.343]
    vertices = [(x, y, heights[j * 3 + i])
                for j, y in enumerate((-0.228, 0, 0.228))
                for i, x in enumerate((-0.232, 0, 0.232))]
    vertices += [(x, y, 0.265) for x, y in ((-0.232, -0.228), (0.232, -0.228),
                                          (0.232, 0.228), (-0.232, 0.228))]
    faces = []
    for j in range(2):
        for i in range(2):
            a = j * 3 + i
            faces += [(a, a + 1, a + 4), (a, a + 4, a + 3)]
    faces += [(10, 2, 1, 0, 9), (11, 8, 5, 2, 10), (12, 6, 7, 8, 11),
              (9, 0, 3, 6, 12), (12, 11, 10, 9)]
    mesh('compost_mound', vertices, faces, 'soil_wet')
    for a, b, color in (((-0.130, -0.080, 0.410), (-0.035, -0.080, 0.459), 'leaf_light'),
                        ((0.075, 0.061, 0.432), (0.158, 0.094, 0.405), 'leaf_dark'),
                        ((-0.074, 0.120, 0.420), (-0.177, 0.153, 0.383), 'leaf')):
        leaf(a, b, 0.036, color)
    rotate(cyl(0.024, 0.078, (0.095, -0.068, 0.416), 'carrot', 6, r2=0.012), y=65, z=25)
    sphere(0.025, (-0.066, 0.021, 0.452), 'path', scale=(1.2, 0.8, 0.5))
    cube((0.123, 0.024, 0.069), (0, -0.291, 0.251), 'wood_dark', 0.006)
    leaf((-0.035, -0.306, 0.236), (0.035, -0.306, 0.276), 0.017, 'leaf_light')
    # Parked fork adds a useful, asymmetric silhouette without cluttering the fill.
    pipe((0.355, 0.065, 0.243), (0.317, 0.104, 0.617), 0.014, 'wood_dark', 6)
    beam((0.285, 0.105, 0.628), (0.348, 0.105, 0.628), 0.018, 'wood')
    beam((0.315, 0.084, 0.237), (0.392, 0.084, 0.237), 0.018, 'metal')
    for x in (0.317, 0.353, 0.389):
        beam((x, 0.084, 0.237), (x + 0.009, 0.037, 0.157), 0.013, 'metal')


def grounded(fn, footprint=None, height=None):
    """Centre the full silhouette, put its lowest vertex on ground, zero every origin.

    common.finalize joins into its first mesh: zeroing *all* mesh origins here
    prevents a primitive's local centre becoming the exported root transform.
    """
    fn()
    # The factory AgX look mutes this deliberately bright, untextured palette.
    # Thumbnail-only display settings; exported materials remain common.mat.
    scene = bpy.context.scene
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'BOTH'
    scene.display.shading.cavity_ridge_factor = 1.1
    scene.display.shading.cavity_valley_factor = 1.0
    scene.display.shading.curvature_ridge_factor = 1.1
    scene.display.shading.curvature_valley_factor = 1.0
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    # Measure evaluated meshes so bevels and future modifiers are covered too.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        data = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ v.co for v in data.vertices)
        evaluated.to_mesh_clear()
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    size = high - low
    if footprint is not None:
        assert max(size.x, size.y) <= footprint + 1e-6, f'footprint {size.x:.4f} x {size.y:.4f}'
    if height is not None:
        assert size.z <= height + 1e-6, f'height {size.z:.4f}'
    offset = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z))
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.location += offset
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    print(f'[AB-ground] {fn} bounds={tuple(round(v, 4) for v in size)} origin=(0,0,0)')


BUILDS = {
    'bot_tender': ('bot', partial(grounded, partial(tender, 0), 0.6, 0.8)),
    'bot_tender_v1': ('bot', partial(grounded, partial(tender, 1), 0.6, 0.8)),
    'bot_tender_v2': ('bot', partial(grounded, partial(tender, 2), 0.6, 0.8)),
    'bot_tender_v3': ('bot', partial(grounded, partial(tender, 3), 0.6, 0.8)),
    'prop_barn': ('building', partial(grounded, barn, 0.95)),
    'prop_market': ('building', partial(grounded, market)),
    'prop_water_tank': ('prop', partial(grounded, tank)),
    'prop_beehive': ('prop', partial(grounded, hive)),
    'prop_compost': ('prop', partial(grounded, compost)),
}

if __name__ == '__main__':
    only = common.args()
    if only and not only <= BUILDS.keys():
        raise ValueError(f'Unknown AB assets: {sorted(only - BUILDS.keys())}')
    common.build(BUILDS)
