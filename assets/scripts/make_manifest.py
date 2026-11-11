"""Merge every export/<name>.json sidecar into export/manifest.json. Plain python3, no Blender needed."""
import glob
import json
import os

EXPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'export')
assets = {}
for path in sorted(glob.glob(os.path.join(EXPORT, '*.json'))):
    if os.path.basename(path) == 'manifest.json':
        continue
    with open(path) as f:
        meta = json.load(f)
    if not os.path.exists(os.path.join(EXPORT, meta['name'] + '.glb')):
        continue
    assets[meta['name']] = {'file': meta['name'] + '.glb', 'group': meta['group'], 'tris': meta['tris'], 'size': meta['size']}
with open(os.path.join(EXPORT, 'manifest.json'), 'w') as f:
    json.dump({'version': 1, 'assets': assets}, f, indent=1, sort_keys=True)
print(f'manifest: {len(assets)} assets')
