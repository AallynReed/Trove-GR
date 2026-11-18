// Assembled-creature viewer: voxel parts on attach-point matrices, with clip playback.
// data: { voxel_scale, rig, parts:[{name,x,y,z,rgb,kind,level,spec,scale}], rest:{ap:[16]}, animations }
import * as THREE from 'three';
import * as AC from './anim-clips.js';
import * as VoxelMesh from '../render/voxel-mesh.js';
import * as ViewerStage from './viewer-stage.js';

let styled = false;

function injectStyles() {
  if (styled) return;
  styled = true;
  const css =
    '.mv-stage{position:relative;flex:1;min-height:0;cursor:grab;--vs-bg-a:#1b2531;--vs-bg-b:#0c1118;' +
      'background:radial-gradient(circle at 50% 40%,var(--vs-bg-a),var(--vs-bg-b) 78%)}' +
    '.mv-stage.grab{cursor:grabbing}' +
    '.mv-stage canvas{display:block;width:100%;height:100%}';
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

// opts: { data, graph, bar, title, brdfUrl, fetchClip(name) -> Promise<ArrayBuffer> }
export function mount(stage, opts) {
  injectStyles();
  stage.classList.add('mv-stage');
  const data = opts.data, graph = opts.graph || null, bar = opts.bar || document.createElement('div');
  const W = stage.clientWidth || 900, H = stage.clientHeight || 560, s = data.voxel_scale;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D creature model. Drag to rotate, scroll to zoom, right-drag to pan.');
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, W / H, 0.001, 1000);

  const scaleM = new THREE.Matrix4().makeScale(s, s, s);
  const scaleOf = {};
  data.parts.forEach((p) => {
    const ps = s * (typeof p.scale === 'number' ? p.scale : 1);
    scaleOf[p.name] = ps === s ? scaleM : new THREE.Matrix4().makeScale(ps, ps, ps);
  });
  // culling is per part: two parts at a joint ride different matrices
  const meshByPart = {}, pickable = [];
  data.parts.forEach((p) => {
    const partMeshes = VoxelMesh.build(p, { brdfUrl: opts.brdfUrl, lightDir: [0.6, 1.0, 0.5], onReady: () => request() });
    partMeshes.forEach((mesh) => {
      mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      scene.add(mesh); pickable.push(mesh);
    });
    meshByPart[p.name] = partMeshes;
  });
  function applyPose(pose) {
    data.parts.forEach((p) => {
      const m = pose[p.name], meshes = meshByPart[p.name];
      if (!m || !meshes) return;
      const sm = scaleOf[p.name] || scaleM;
      for (const mesh of meshes) mesh.matrix.fromArray(m).multiply(sm);
    });
  }
  applyPose(data.rest);

  const box = new THREE.Box3(), v = new THREE.Vector3();
  data.parts.forEach((p) => {
    if (!data.rest[p.name]) return;
    const M = new THREE.Matrix4().fromArray(data.rest[p.name]).multiply(scaleOf[p.name] || scaleM);
    for (let i = 0; i < p.x.length; i++) { v.set(p.x[i], p.y[i], p.z[i]).applyMatrix4(M); box.expandByPoint(v); }
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const modelR = Math.max(size.x, size.y, size.z) || 1;
  // the model orbits its own centre; pan is an offset in camera space
  const pivot = center.clone(), target = new THREE.Vector3();
  let panX = 0, panY = 0;
  const sph = { r: modelR * 2.2, t: Math.PI * 0.25, p: Math.PI * 0.42 };
  const dir = new THREE.Vector3(), bRight = new THREE.Vector3(), bUp = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  function cam() {
    dir.set(Math.sin(sph.p) * Math.sin(sph.t), Math.cos(sph.p), Math.sin(sph.p) * Math.cos(sph.t));
    bRight.crossVectors(WORLD_UP, dir).normalize();
    bUp.crossVectors(dir, bRight);
    target.copy(pivot).addScaledVector(bRight, panX).addScaledVector(bUp, panY);
    camera.position.copy(target).addScaledVector(dir, sph.r);
    camera.lookAt(target);
  }
  cam();

  const el = renderer.domElement;
  let drag = 0, lx = 0, ly = 0, pinch = 0;
  const rot = (dx, dy) => { sph.t -= dx * 0.01; sph.p = Math.max(0.05, Math.min(Math.PI - 0.05, sph.p - dy * 0.01)); };
  // panning keeps the grabbed voxel under the cursor (one raycast per drag)
  const caster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const viewDir = new THREE.Vector3(), scratch = new THREE.Vector3();
  let anchor = null;
  function grabAnchor(e) {
    anchor = null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld();
    caster.setFromCamera(ndc, camera);
    const hit = caster.intersectObjects(pickable, false)[0];
    if (hit && hit.point) anchor = hit.point.clone();
  }
  function panDepth() {
    if (!anchor) return sph.r;
    camera.getWorldDirection(viewDir);
    return Math.max(1e-6, scratch.copy(anchor).sub(camera.position).dot(viewDir));
  }
  function pan(dx, dy) {
    camera.updateMatrixWorld();
    const k = 2 * panDepth() * Math.tan(camera.fov * Math.PI / 360) / (stage.clientHeight || 1);
    panX -= dx * k; panY += dy * k;
  }
  const zoom = (f) => { sph.r = Math.max(modelR * 0.4, Math.min(modelR * 9, sph.r * f)); };
  function down(e) {
    if (e.pointerType === 'touch') return;
    drag = (e.button === 2 || e.shiftKey) ? 2 : 1; lx = e.clientX; ly = e.clientY;
    if (drag === 2) grabAnchor(e);
    stage.classList.add('grab');
    try { el.setPointerCapture(e.pointerId); } catch { /* already released */ }
    e.preventDefault();
  }
  function move(e) {
    if (!drag || e.pointerType === 'touch') return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    if (drag === 2) pan(dx, dy); else rot(dx, dy);
    cam(); request();
  }
  function upE() { drag = 0; anchor = null; stage.classList.remove('grab'); }
  function wheel(e) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); cam(); request(); }
  const tdist = (e) => { const a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); };
  function ts(e) {
    if (e.touches.length === 1) { drag = 1; lx = e.touches[0].clientX; ly = e.touches[0].clientY; }
    else if (e.touches.length === 2) { drag = 0; pinch = tdist(e); }
  }
  function tm(e) {
    if (e.touches.length === 1 && drag === 1) {
      const t = e.touches[0];
      rot(t.clientX - lx, t.clientY - ly); lx = t.clientX; ly = t.clientY; cam(); request();
    } else if (e.touches.length === 2) {
      const d = tdist(e);
      if (pinch) { zoom(pinch / d); cam(); request(); }
      pinch = d;
    }
    e.preventDefault();
  }
  function te() { drag = 0; pinch = 0; }
  const noMenu = (e) => e.preventDefault();
  el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', upE);
  el.addEventListener('pointercancel', upE); el.addEventListener('lostpointercapture', upE);
  el.addEventListener('wheel', wheel, { passive: false }); el.addEventListener('contextmenu', noMenu);
  el.addEventListener('touchstart', ts, { passive: false }); el.addEventListener('touchmove', tm, { passive: false }); el.addEventListener('touchend', te);
  function onResize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); request();
  }
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(() => onResize());
  ro.observe(stage);

  // render on demand; a rAF loop runs only while a clip plays
  let alive = true, anim = null, want = null, animStart = 0, raf = 0, pending = false;
  const loaded = {};
  let programs = {}, prog = null, barCtl = null;
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1), _m4 = new THREE.Matrix4();
  const renderOnce = () => renderer.render(scene, camera);
  function request() {
    if (anim || pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; renderOnce(); });
  }
  const tools = ViewerStage.attach({
    stage, canvas: renderer.domElement, render: renderOnce, name: opts.title,
    scene, focus: () => ({ center: pivot, radius: modelR }),
  });
  function applyFrame(at) {
    data.parts.forEach((p) => {
      const pose = AC.sample(at, p.name), meshes = meshByPart[p.name];
      if (!pose || !meshes) return;
      const sm = scaleOf[p.name] || scaleM, m = pose.m;
      if (m) _m4.set(m[0], m[3], m[6], pose.p[0], m[1], m[4], m[7], pose.p[1], m[2], m[5], m[8], pose.p[2], 0, 0, 0, 1);
      else {
        _p.set(pose.p[0], pose.p[1], pose.p[2]);
        _q.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
        _m4.compose(_p, _q, _one);
      }
      for (const mesh of meshes) mesh.matrix.copy(_m4).multiply(sm);
    });
  }
  function loop(t) {
    if (!alive || !prog) return;
    raf = requestAnimationFrame(loop);
    applyFrame(AC.frameAt(prog, (t - animStart) / 1000));
    renderOnce();
  }
  const setActive = (name) => { if (barCtl) barCtl.setActive(name); };
  function startProgram(key) {
    const p = AC.timeline(programs[key], loaded);
    if (!p) return;
    prog = p; anim = key; animStart = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  }
  const fetchClip = (name) => opts.fetchClip(name).then((buf) => { loaded[name] = AC.decode(buf); });
  function play(key) {
    cancelAnimationFrame(raf); anim = null; prog = null; want = key;
    if (!key) { applyPose(data.rest); renderOnce(); setActive(null); return Promise.resolve(); }
    const spec = programs[key];
    if (!spec) return Promise.resolve();
    setActive(key);
    const need = spec.clips.filter((n) => !loaded[n]);
    if (!need.length) { startProgram(key); return Promise.resolve(); }
    if (barCtl) barCtl.setLoading(key, true);
    return Promise.all(need.map(fetchClip))
      .then(() => { if (want === key) startProgram(key); })
      .catch((e) => console.error(`animation "${key}":`, e))
      .finally(() => { if (barCtl) barCtl.setLoading(key, false); });
  }

  const kit = AC.programs(data.animations || {}, graph);
  programs = kit.programs;
  barCtl = AC.bar({ host: bar, kit, onPick: play, onResize, hint: 'drag rotate · scroll zoom · right-drag pan' });
  onResize();
  play(null);

  return {
    play,
    state() {
      const spec = anim ? programs[anim] : null;
      return {
        anim, want, alive, cached: Object.keys(loaded), buttons: Object.keys(programs),
        program: spec ? { clips: spec.clips.slice(), blends: spec.blends.slice() } : null,
        timeline: prog ? { starts: prog.starts.slice(), blends: prog.blends.slice(), total: prog.total } : null,
        clip: prog ? { fps: prog.A[0].fps, frameCount: prog.A[0].frameCount, apCount: prog.A[0].apCount, dataLen: prog.A[0].data && prog.A[0].data.length } : null,
      };
    },
    // poses one frame of a loaded clip and returns each part's mesh matrix (rAF-free test hook)
    async poseFrame(name, fi) {
      if (!loaded[name]) await fetchClip(name);
      const A = loaded[name];
      if (!A || !A.frameCount) return null;
      cancelAnimationFrame(raf); anim = null; prog = null;
      applyFrame({ A, f: ((fi % A.frameCount) + A.frameCount) % A.frameCount, B: null, g: 0, u: 0 });
      renderOnce();
      const out = {};
      data.parts.forEach((p) => {
        const m = meshByPart[p.name] && meshByPart[p.name][0];
        if (m) out[p.name] = Array.from(m.matrix.elements);
      });
      return out;
    },
    dispose() {
      alive = false; cancelAnimationFrame(raf);
      tools.dispose();
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', upE);
      el.removeEventListener('pointercancel', upE); el.removeEventListener('lostpointercapture', upE);
      el.removeEventListener('wheel', wheel); el.removeEventListener('contextmenu', noMenu);
      el.removeEventListener('touchstart', ts); el.removeEventListener('touchmove', tm); el.removeEventListener('touchend', te);
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      Object.values(meshByPart).forEach((ms) => ms.forEach((m) => { m.geometry.dispose(); m.material.dispose(); }));
      renderer.dispose();
      el.remove();
      stage.classList.remove('mv-stage', 'grab');
    },
  };
}
