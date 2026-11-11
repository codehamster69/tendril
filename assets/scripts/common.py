"""Shared helpers for every asset script. Run scripts headless:
    blender -b --factory-startup -P assets/scripts/<group>.py -- [--only name1,name2]
Conventions (see brain/CONTRACTS.md#assets): Blender Z-up, 1 unit = 1 m = 1 tile. Ground is z = 0.
Origin (0,0,0) is the tile centre at ground level. Tiles fill z in [-0.2, 0]; everything else stands on z = 0.
"""
import json
import math
import os
import sys

import bpy
import bmesh

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
EXPORT = os.path.join(ROOT, 'export')
THUMBS = os.path.join(ROOT, 'thumbs')

# One shared palette. Asset scripts must use these names, never raw colours.
PALETTE = {
    'grass': (0.353, 0.620, 0.294), 'grass_dark': (0.247, 0.478, 0.220),
    'soil': (0.478, 0.322, 0.188), 'soil_wet': (0.290, 0.192, 0.118), 'path': (0.773, 0.682, 0.510),
    'stone': (0.561, 0.553, 0.529), 'stone_dark': (0.400, 0.392, 0.376),
    'wood': (0.620, 0.431, 0.259), 'wood_dark': (0.400, 0.267, 0.157),
    'red': (0.690, 0.188, 0.165), 'red_dark': (0.431, 0.102, 0.086),
    'leaf': (0.420, 0.690, 0.310), 'leaf_dark': (0.243, 0.478, 0.200), 'leaf_light': (0.600, 0.800, 0.400),
    'carrot': (0.941, 0.541, 0.141), 'wheat': (0.902, 0.765, 0.290), 'clover': (0.561, 0.749, 0.416),
    'clover_flower': (0.910, 0.890, 0.960), 'pumpkin': (0.824, 0.376, 0.102), 'berry': (0.545, 0.157, 0.369),
    'bot_body': (0.290, 0.565, 0.851), 'bot_light': (0.875, 0.902, 0.933), 'bot_dark': (0.180, 0.220, 0.282),
    'metal': (0.620, 0.650, 0.690), 'accent': (0.973, 0.796, 0.235), 'water': (0.302, 0.600, 0.850),
    'honey': (0.957, 0.690, 0.157), 'white': (0.950, 0.950, 0.940), 'black': (0.080, 0.080, 0.090),
}

BUDGETS = {'tile': 300, 'crop': 300, 'bot': 1500, 'building': 3000, 'prop': 1500}


def args():
    """Parse `-- --only a,b` after Blender's own args. Returns the set of names, or None for all."""
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if '--only' in argv:
        return set(argv[argv.index('--only') + 1].split(','))
    return None


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name):
    """Palette material, created once per scene. Flat colour, matte."""
    m = bpy.data.materials.get(name)
    if m:
        return m
    r, g, b = PALETTE[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1)
    bsdf.inputs['Roughness'].default_value = 0.85
    m.diffuse_color = (r, g, b, 1)
    return m


def paint(obj, name):
    obj.data.materials.clear()
    obj.data.materials.append(mat(name))
    return obj


def tris(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    n = sum(len(f.verts) - 2 for f in bm.faces)
    bm.free()
    return n


def finalize(name, group):
    """Join every mesh in the scene into one object `name`, apply modifiers, flat-shade, check the budget,
    export assets/export/<name>.glb, a sidecar <name>.json and a thumbnail assets/thumbs/<name>.png.
    Raises if over budget. Returns the triangle count."""
    assert group in BUDGETS, group
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    assert meshes, f'{name}: no meshes'
    for o in meshes:
        if o.modifiers:
            bpy.context.view_layer.objects.active = o
            for mod in list(o.modifiers):
                bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    for p in obj.data.polygons:
        p.use_smooth = False
    n = tris(obj)
    budget = BUDGETS[group]
    if n > budget:
        raise RuntimeError(f'{name}: {n} triangles exceeds {group} budget {budget}')
    os.makedirs(EXPORT, exist_ok=True)
    os.makedirs(THUMBS, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(EXPORT, name + '.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_materials='EXPORT',
    )
    bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
    size = [max(v[i] for v in bb) - min(v[i] for v in bb) for i in range(3)]
    with open(os.path.join(EXPORT, name + '.json'), 'w') as f:
        json.dump({'name': name, 'group': group, 'tris': n, 'budget': budget,
                   'size': [round(s, 3) for s in size]}, f)
    thumbnail(obj, os.path.join(THUMBS, name + '.png'))
    print(f'[asset] {name} group={group} tris={n}/{budget} size={size}')
    return n


def thumbnail(obj, path, res=256):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    bb = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = [min(v[i] for v in bb) for i in range(3)]
    hi = [max(v[i] for v in bb) for i in range(3)]
    c = [(lo[i] + hi[i]) / 2 for i in range(3)]
    r = max(0.5, max(hi[i] - lo[i] for i in range(3)))
    cam_data = bpy.data.cameras.new('thumb_cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = r * 1.6
    cam = bpy.data.objects.new('thumb_cam', cam_data)
    scene.collection.objects.link(cam)
    d = r * 3
    cam.location = (c[0] + d * 0.62, c[1] - d * 0.62, c[2] + d * 0.48)
    direction = [c[i] - cam.location[i] for i in range(3)]
    from mathutils import Vector
    cam.rotation_euler = Vector(direction).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def build(table):
    """table: {name: (group, fn)}. Runs each fn on a fresh scene, honours --only. Exits non-zero on failure."""
    only = args()
    failed = []
    for name, (group, fn) in table.items():
        if only and name not in only:
            continue
        reset()
        try:
            fn()
            finalize(name, group)
        except Exception as e:  # report every failure, then exit non-zero
            failed.append(f'{name}: {e}')
            print(f'[asset-error] {name}: {e}')
    if failed:
        print('[asset-failed]', failed)
        sys.exit(1)


# ---- small primitive helpers (all return the new object) ----
def cube(size=(1, 1, 1), loc=(0, 0, 0), color='white', bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        m = o.modifiers.new('bevel', 'BEVEL')
        m.width = bevel
        m.segments = 1
    return paint(o, color)


def cyl(r=0.5, h=1, loc=(0, 0, 0), color='white', verts=8, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=loc)
    return paint(bpy.context.active_object, color)


def cone(r=0.5, h=1, loc=(0, 0, 0), color='white', verts=8):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=0, depth=h, location=loc)
    return paint(bpy.context.active_object, color)


def sphere(r=0.5, loc=(0, 0, 0), color='white', subdiv=1, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=loc)
    o = bpy.context.active_object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return paint(o, color)


def rotate(o, x=0.0, y=0.0, z=0.0):
    o.rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
    return o
