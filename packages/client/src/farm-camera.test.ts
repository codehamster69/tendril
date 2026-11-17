import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FarmCamera, INSET_MS, applyInset, applyLocked, autoPitch, defaultPose, easeFactor, fitDistance, groundPoint, placeCamera, wrapAngle } from './farm-camera.ts';

type Handler = (e: unknown) => void;
function fakeDom() {
  const handlers = new Map<string, Handler>();
  const dom = {
    style: { touchAction: '' },
    classList: { add() {}, remove() {} },
    addEventListener: (t: string, h: Handler) => { handlers.set(t, h); },
    removeEventListener: (t: string) => { handlers.delete(t); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    setPointerCapture() {},
  };
  return { dom: dom as unknown as HTMLElement, handlers };
}
const rig = () => {
  const cam = new THREE.PerspectiveCamera(38, 1000 / 600, 0.2, 1200);
  const { dom, handlers } = fakeDom();
  const fc = new FarmCamera(cam, dom);
  return { cam, fc, handlers };
};
const settle = (fc: FarmCamera, seconds = 3) => { for (let i = 0; i < seconds * 60; i++) fc.update(1 / 60); };
const wheel = (h: Map<string, Handler>, x: number, y: number, deltaY: number) =>
  h.get('wheel')!({ clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey: false, preventDefault() {} });

describe('camera maths', () => {
  it('default pose reproduces the legacy position and target', () => {
    const cam = new THREE.PerspectiveCamera(38, 1.5);
    placeCamera(cam, defaultPose());
    assert.ok(cam.position.distanceTo(new THREE.Vector3(10, 14, 16)) < 1e-6);
    const g = groundPoint(cam, 0, 0)!;
    assert.ok(Math.hypot(g.x - 3.5, g.z - 3.5) < 1e-6);
  });

  it('anchor lock keeps the ground point under an off-centre pointer', () => {
    const cam = new THREE.PerspectiveCamera(38, 1000 / 600);
    const pose = { ...defaultPose() };
    placeCamera(cam, pose);
    const before = groundPoint(cam, 0.6, -0.4)!.clone();
    for (let i = 0; i < 8; i++) applyLocked(pose, { dist: pose.dist * 0.85, pitch: pose.pitch + 0.02 }, cam, 0.6, -0.4);
    placeCamera(cam, pose);
    const after = groundPoint(cam, 0.6, -0.4)!;
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.01);
    assert.ok(pose.dist < defaultPose().dist * 0.4);
  });

  it('lock also holds across a yaw change', () => {
    const cam = new THREE.PerspectiveCamera(38, 1.6);
    const pose = { ...defaultPose() };
    placeCamera(cam, pose);
    const before = groundPoint(cam, -0.5, 0.2)!.clone();
    applyLocked(pose, { yaw: pose.yaw + Math.PI / 2 }, cam, -0.5, 0.2);
    placeCamera(cam, pose);
    const after = groundPoint(cam, -0.5, 0.2)!;
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.01);
  });

  it('easing, wrapping, pitch curve and fit distance behave', () => {
    assert.equal(easeFactor(1, 11, true), 1);
    assert.ok(easeFactor(0.016) > 0.15 && easeFactor(0.016) < 0.2);
    assert.ok(easeFactor(10) > 0.999);
    assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
    assert.ok(Math.abs(wrapAngle(0.3 + 4 * Math.PI) - 0.3) < 1e-9);
    assert.equal(autoPitch(0, 100), 0.6);
    assert.ok(Math.abs(autoPitch(1000, 100) - 1.12) < 1e-9);
    assert.ok(autoPitch(30, 100) > autoPitch(10, 100));
    assert.ok(fitDistance(20, 38, 0.5) > fitDistance(20, 38, 2));   // narrow screens need more distance
  });
});

describe('FarmCamera', () => {
  it('starts at the legacy pose without bounds', () => {
    const { cam } = rig();
    assert.ok(cam.position.distanceTo(new THREE.Vector3(10, 14, 16)) < 1e-6);
  });

  it('wheel zoom to cursor keeps the point under an off-centre pointer; centre mode does not', () => {
    const a = rig();
    settle(a.fc, 1);
    const ndc = [0.4, -0.3] as const;
    const px = (ndc[0] + 1) / 2 * 1000, py = (1 - ndc[1]) / 2 * 600;
    const before = a.fc.groundAt(...ndc)!.clone();
    for (let i = 0; i < 8; i++) wheel(a.handlers, px, py, -120);
    settle(a.fc);
    const after = a.fc.groundAt(...ndc)!;
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.01, `moved ${Math.hypot(after.x - before.x, after.z - before.z)}`);
    assert.ok(a.fc.distance < 19);

    const b = rig();
    b.fc.zoomMode = 'center';
    settle(b.fc, 1);
    const before2 = b.fc.groundAt(...ndc)!.clone();
    for (let i = 0; i < 8; i++) wheel(b.handlers, px, py, -120);
    settle(b.fc);
    const after2 = b.fc.groundAt(...ndc)!;
    assert.ok(Math.hypot(after2.x - before2.x, after2.z - before2.z) > 0.5);
  });

  it('fit frames the bounds, scales distance and re-frames when land grows while auto-framed', () => {
    const { fc } = rig();
    fc.setBounds({ x0: -0.5, x1: 7.5, z0: -0.5, z1: 7.5 });
    assert.ok(fc.autoFramed());
    settle(fc);
    assert.ok(Math.hypot(fc.target.x - 3.5, fc.target.z - 3.5) < 0.01);
    const small = fc.distance;
    fc.setBounds({ x0: -0.5, x1: 99.5, z0: -0.5, z1: 99.5 });
    settle(fc);
    assert.ok(fc.distance > small * 5, `${fc.distance} vs ${small}`);
    assert.ok(Math.hypot(fc.target.x - 49.5, fc.target.z - 49.5) < 0.01);
    fc.focus(10, 10, { snap: true });
    assert.equal(fc.autoFramed(), false);
    fc.setBounds({ x0: -0.5, x1: 199.5, z0: -0.5, z1: 99.5 });
    assert.ok(Math.hypot(fc.target.x - 10, fc.target.z - 10) < 0.01, 'manual view is not re-framed');
    fc.fit(true);
    assert.ok(fc.autoFramed());
  });

  it('clamps the target to bounds plus margin and zoom to min/max distance', () => {
    const { fc } = rig();
    fc.setBounds({ x0: -0.5, x1: 7.5, z0: -0.5, z1: 7.5 });
    fc.focus(500, -500, { snap: true });
    assert.ok(fc.target.x <= 7.5 + 3 + 1e-9 && fc.target.z >= -0.5 - 3 - 1e-9);
    for (let i = 0; i < 40; i++) fc.zoomAt(0.5, 0, 0);
    settle(fc);
    assert.ok(Math.abs(fc.distance - 3) < 0.05);
    for (let i = 0; i < 40; i++) fc.zoomAt(2, 0, 0);
    settle(fc);
    assert.ok(fc.distance > 29.9 && fc.distance < 200);
  });

  it('rotate turns 90 degrees about the screen centre', () => {
    const { fc } = rig();
    settle(fc, 1);
    const c0 = fc.groundAt(0, 0)!.clone(), yaw = fc.yaw;
    fc.rotate(1);
    settle(fc);
    const c1 = fc.groundAt(0, 0)!;
    assert.ok(Math.hypot(c1.x - c0.x, c1.z - c0.z) < 0.01);
    assert.ok(Math.abs(Math.abs(fc.yaw - yaw) - Math.PI / 2) < 1e-3);
  });

  it('follow tracks a source, zoom keeps it centred, focus cancels it', () => {
    const { fc, handlers } = rig();
    const pos = { x: 20, z: 12 };
    fc.follow(() => pos);
    assert.equal(fc.following, true);
    settle(fc);
    assert.ok(Math.hypot(fc.target.x - 20, fc.target.z - 12) < 0.05);
    for (let i = 0; i < 6; i++) wheel(handlers, 900, 100, -120);
    settle(fc);
    assert.ok(Math.hypot(fc.target.x - 20, fc.target.z - 12) < 0.05, 'zoom while following does not drift the target');
    pos.x = 25;
    settle(fc);
    assert.ok(Math.abs(fc.target.x - 25) < 0.05);
    fc.focus(0, 0);
    assert.equal(fc.following, false);
  });

  it('fires onChange when the pose moves and visibleQuad gives four clamped ground points', () => {
    const { fc } = rig();
    let n = 0;
    fc.onChange = () => { n++; };
    fc.update(1 / 60);
    const idle = n;
    fc.focus(30, 30);
    settle(fc, 1);
    assert.ok(n > idle);
    const quad = fc.visibleQuad(40);
    assert.equal(quad.length, 4);
    const eye = new THREE.Vector3(fc.target.x, 0, fc.target.z);
    for (const p of quad) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && p.y === 0 && p.distanceTo(eye) < 200);
  });

  it('dispose removes listeners', () => {
    const { fc, handlers } = rig();
    assert.ok(handlers.has('wheel'));
    fc.dispose();
    assert.equal(handlers.size, 0);
  });
});

describe('slate inset, framing, flyTo and double-click', () => {
  const island = { x0: 0, x1: 8, z0: 0, z1: 8 };
  const W = 1000, H = 600;

  it('applyInset moves the frame centre left by half the inset, and clears it at zero', () => {
    const cam = new THREE.PerspectiveCamera(38, W / H);
    placeCamera(cam, defaultPose());
    const centre = new THREE.Vector3(3.5, 0, 3.5);
    applyInset(cam, 400, W, H);
    placeCamera(cam, defaultPose());
    assert.ok(Math.abs(centre.clone().project(cam).x - -0.4) < 1e-6);
    applyInset(cam, 0, W, H);
    placeCamera(cam, defaultPose());
    assert.ok(Math.abs(centre.clone().project(cam).x) < 1e-6);
  });

  it('with the slate open, the farm is re-framed in the narrower free area (farther away)', () => {
    const { fc } = rig();
    fc.setBounds(island);
    settle(fc, 2);
    const open = fc.distance;
    fc.setInset(800, true);
    settle(fc, 2);
    assert.ok(fc.distance > open * 1.5, `expected a farther frame, got ${fc.distance} vs ${open}`);
  });

  it('the inset tweens over INSET_MS and lands exactly', () => {
    const { cam, fc } = rig();
    fc.setInset(400);
    const frames = Math.round(INSET_MS / 1000 * 60);
    for (let i = 0; i < frames / 2; i++) fc.update(1 / 60);
    const mid = cam.view?.enabled ? cam.view.offsetX : 0;
    assert.ok(mid > 0 && mid < 200, `mid-tween offset ${mid}`);
    for (let i = 0; i < frames; i++) fc.update(1 / 60);
    assert.ok(Math.abs((cam.view?.offsetX ?? 0) - 200) < 1e-6);
  });

  it('a new plot re-frames even after the player moved the camera', () => {
    const { fc } = rig();
    fc.setBounds(island);
    settle(fc, 1);
    fc.focus(30, 30, { snap: true });
    assert.equal(fc.autoFramed(), false);
    fc.setBounds({ x0: 0, x1: 10, z0: 0, z1: 8 });
    assert.equal(fc.autoFramed(), true);
  });

  it('flyTo glides the target over the point and keeps the distance', () => {
    const { fc } = rig();
    settle(fc, 1);
    const dist = fc.distance;
    fc.flyTo({ x: 20, z: 5 });
    settle(fc, 3);
    assert.ok(Math.hypot(fc.target.x - 20, fc.target.z - 5) < 0.05);
    assert.ok(Math.abs(fc.distance - dist) < 1e-3);
  });

  it('introGlide starts far out and eases down to the framed farm', () => {
    const { fc } = rig();
    fc.setBounds(island);
    settle(fc, 2);
    const settled = fc.distance;
    fc.introGlide();
    const start = fc.distance;
    assert.ok(start > settled * 1.2);
    fc.update(1 / 60);
    assert.ok(fc.distance < start);
    settle(fc, 3);
    assert.ok(Math.abs(fc.distance - settled) < 0.05);
  });

  it('a double-click on the right half centres the view to the right of the old target', () => {
    const { fc, handlers } = rig();
    fc.setBounds(null);
    settle(fc, 1);
    const x0 = fc.target.x;
    handlers.get('dblclick')!({ clientX: 750, clientY: 300 });
    settle(fc, 3);
    assert.ok(fc.target.x !== x0 || fc.target.z !== 3.5, 'target should move toward the double-click');
  });

  it('camera moves call requestRender as well as onChange', () => {
    const { fc } = rig();
    let renders = 0;
    fc.requestRender = () => { renders++; };
    fc.focus(10, 10);
    settle(fc, 1);
    assert.ok(renders > 0);
  });
});
