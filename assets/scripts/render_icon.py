"""Render the desktop app icon (headless):
    /opt/homebrew/bin/blender -b --factory-startup -P assets/scripts/render_icon.py
Writes assets/renders/icon_{1024,256,64,32}.png and copies the 1024 to packages/client/build/icon.png.
Composition: squircle teal tile (camera-facing card) + gardener bot on a soil patch with crops + a tendril
that breaks the tile's top edge. Deterministic: fixed seeds, no randomness."""
import math
import os
import shutil
import subprocess
import sys

import bpy
from mathutils import Euler, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ROOT = common.ROOT
OUT = os.path.join(ROOT, 'renders')
RES = 1024
ELEV = 24.0          # camera elevation, degrees above horizon
AZIM = 18.0          # camera azimuth, degrees to the right of straight-on front (three-quarter view)
TILE = 1.30          # tile side in metres (ortho image plane units)
TILE_FRAC = 0.82     # tile share of canvas
TEAL = (0.0, 0.0, 0.0)


def srgb(h):
    h = h.lstrip('#')
    return tuple(((int(h[i:i + 2], 16) / 255) ** 2.2) for i in (0, 2, 4))


def import_glb(name, loc=(0, 0, 0), rot_z=0.0, scale=1.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(common.EXPORT, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    holder = bpy.data.objects.new('h_' + name, None)
    bpy.context.scene.collection.objects.link(holder)
    for r in roots:
        r.parent = holder
    holder.location = loc
    holder.rotation_euler = (0, 0, math.radians(rot_z))
    holder.scale = (scale,) * 3
    return holder


def squircle(n=5.0, steps=96):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = math.copysign(abs(c) ** (2 / n), c)
        y = math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    return pts


def rounded_rect(half, radius, per_corner=14):
    pts = []
    for cx, cy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for k in range(per_corner + 1):
            a = math.radians(a0 + 90 * k / per_corner)
            pts.append((cx * (half - radius) + radius * math.cos(a), cy * (half - radius) + radius * math.sin(a)))
    return pts


def poly_prism(name, pts, depth, material):
    me = bpy.data.meshes.new(name)
    n = len(pts)
    verts = [(x, y, 0) for x, y in pts] + [(x, y, -depth) for x, y in pts]
    faces = [list(range(n)), list(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, n + i, n + j, j])
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(material)
    bev = o.modifiers.new('bevel', 'BEVEL')
    bev.width = 0.022
    bev.segments = 3
    bev.limit_method = 'ANGLE'
    for p in me.polygons:
        p.use_smooth = False
    return o


def flat_mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = 0.85
    return m


def tile_material():
    """Deep teal with a gradient to a lighter top, driven by object-space Y."""
    m = bpy.data.materials.new('icon_tile')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = 0.9
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = -TILE / 2
    mr.inputs['From Max'].default_value = TILE / 2
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*srgb('#143D42'), 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (*srgb('#1F5A60'), 1)
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    nt.links.new(sep.outputs['Y'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    return m


def tendril(parent):
    """Green sprout in the tile's local frame (x right, y up, z toward camera); crosses the top edge."""
    green = flat_mat('t_stem', common.PALETTE['leaf'])
    light = flat_mat('t_leaf', common.PALETTE['leaf_light'])
    dark = flat_mat('t_leaf_d', common.PALETTE['leaf_dark'])
    cu = bpy.data.curves.new('tendril', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 0.034
    cu.bevel_resolution = 3
    sp = cu.splines.new('BEZIER')
    pts = [((0.34, -0.20, 0.8), (0.34, -0.10, 0.8), (0.34, 0.0, 0.8)),
           ((0.38, 0.22, 0.5), (0.38, 0.30, 0.5), (0.38, 0.40, 0.5)),
           ((0.34, 0.56, 0.4), (0.32, 0.61, 0.4), (0.29, 0.65, 0.4))]
    sp.bezier_points.add(len(pts) - 1)
    for bp, (l, c, r) in zip(sp.bezier_points, pts):
        bp.handle_left, bp.co, bp.handle_right = l, c, r
        bp.handle_left_type = bp.handle_right_type = 'ALIGNED'
    o = bpy.data.objects.new('tendril', cu)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    cu.materials.append(green)

    def leaf(loc, rot, size, m):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=loc)
        lf = bpy.context.active_object
        lf.scale = size
        lf.rotation_euler = rot
        lf.data.materials.append(m)
        lf.parent = parent
        for p in lf.data.polygons:
            p.use_smooth = False

    # leaves sized for 32 px legibility; one pair near the tip, one lower
    leaf((0.18, 0.64, 0.4), (0, 0, math.radians(15)), (0.12, 0.055, 0.025), light)
    leaf((0.46, 0.58, 0.4), (0, 0, math.radians(-30)), (0.12, 0.055, 0.025), dark)
    leaf((0.26, 0.34, 0.5), (0, 0, math.radians(30)), (0.11, 0.05, 0.025), green)


def world_and_render():
    sc = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    print('[icon] engines:', engines)
    eng = next(e for e in engines if e.startswith('BLENDER_EEVEE'))
    sc.render.engine = eng
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.display_settings.display_device = 'sRGB'
    ee = getattr(sc, 'eevee', None)
    if ee:
        for attr, val in (('taa_render_samples', 96), ('use_gtao', True), ('use_shadows', True),
                          ('use_raytracing', False), ('use_shadow_jitter_viewport', False)):
            if hasattr(ee, attr):
                setattr(ee, attr, val)
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.70, 0.80, 0.82, 1)
    bg.inputs['Strength'].default_value = 0.55
    sc.world = w


def main():
    common.reset()
    sc = bpy.context.scene
    world_and_render()

    # camera: orthographic, looking at the target from front-right-above
    tgt = Vector((0.0, 0.0, 0.30))
    el, az = math.radians(ELEV), math.radians(AZIM)
    d = Vector((-math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), -math.sin(el)))  # view direction
    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = TILE / TILE_FRAC
    cam_data.clip_start, cam_data.clip_end = 0.1, 50
    cam = bpy.data.objects.new('cam', cam_data)
    sc.collection.objects.link(cam)
    cam.location = tgt - d * 8
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam

    # tile card, parallel to the image plane, behind the scene
    card = bpy.data.objects.new('card', None)
    sc.collection.objects.link(card)
    card.location = tgt + d * 1.0
    card.rotation_euler = cam.rotation_euler
    tile = poly_prism('tile', squircle(5.0), 0.12, tile_material())
    tile.scale = (TILE / 2, TILE / 2, 1)
    tile.parent = card
    # subtle lighter lip along the top: a thin crescent of the same shape shifted down, in front
    lip = poly_prism('lip', squircle(5.0), 0.02, flat_mat('lip', srgb('#2C7078')))
    lip.scale = (TILE / 2 * 0.985, TILE / 2 * 0.985, 1)
    lip.location = (0, 0, 0.0)
    lip.parent = card
    cover = poly_prism('cover', squircle(5.0), 0.02, tile.data.materials[0])
    cover.scale = (TILE / 2 * 0.985, TILE / 2 * 0.985, 1)
    cover.location = (0, -0.012, 0.004)
    cover.parent = card

    # scene content
    import_glb('tile_soil', (0, 0.0, 0), 0, 0.82)
    import_glb('bot_tender', (0.0, 0.08, 0.0), 0, 1.5)
    import_glb('crop_carrot_s2', (-0.34, -0.30, 0.0), 20, 1.0)
    import_glb('crop_wheat_s2', (0.43, -0.28, 0.0), -15, 0.9)
    import_glb('crop_carrot_s1', (0.0, -0.34, 0.0), 0, 0.8)
    tendril(card)

    # lights: soft key from upper left (camera-relative), gentle fill
    key = bpy.data.lights.new('key', 'SUN')
    key.energy, key.angle = 3.2, math.radians(14)
    key.color = (1.0, 0.97, 0.92)
    ko = bpy.data.objects.new('key', key)
    sc.collection.objects.link(ko)
    ko.rotation_euler = Euler((math.radians(52), 0, math.radians(-38)), 'ZXY')
    ko.rotation_euler = Euler((math.radians(55), math.radians(0), math.radians(-30)), 'XYZ')
    fill = bpy.data.lights.new('fill', 'SUN')
    fill.energy, fill.angle = 0.7, math.radians(40)
    fill.color = (0.85, 0.93, 1.0)
    fill.use_shadow = False
    fo = bpy.data.objects.new('fill', fill)
    sc.collection.objects.link(fo)
    fo.rotation_euler = Euler((math.radians(70), 0, math.radians(60)), 'XYZ')

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'icon_1024.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)

    for size in (256, 64, 32):
        dst = os.path.join(OUT, f'icon_{size}.png')
        subprocess.run(['sips', '-z', str(size), str(size), path, '--out', dst], check=True, capture_output=True)
    bd = os.path.join(ROOT, '..', 'packages', 'client', 'build')
    os.makedirs(bd, exist_ok=True)
    shutil.copyfile(path, os.path.join(bd, 'icon.png'))
    print('[icon] done')


main()
