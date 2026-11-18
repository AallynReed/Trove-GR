// Voxel sets -> meshes with only visible faces, shaded with Trove's object shader.
import * as THREE from 'three';

// Per face: normal, then tangents u, v with u x v = n (quads wind CCW from outside).
const FACES = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 0, 0, 1, 1, 0, 0],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
];

const MAX_CELLS = 16 << 20;

const isOpaque = (kind) => kind === 0 || kind === 2;

const BRDF_MAP = { value: null };
let brdfLoad = null;
const brdfWaiters = [];

// A neutral white sun; the game feeds these per biome and time of day.
const SUN = 0.66, SUN_SPEC = 0.85, AMBIENT = 0.36;
const FALLBACK_DIR = [0.7, 1.0, 0.55];
let LIGHT = null, HOST_DIR = null, CTL = null;

function ensureLight() {
  if (LIGHT) return LIGHT;
  LIGHT = {
    kBrdfMap: BRDF_MAP,
    kSun: { value: new THREE.Vector3(SUN, SUN, SUN) },
    kSunSpec: { value: new THREE.Vector3(SUN_SPEC, SUN_SPEC, SUN_SPEC) },
    kAmbient: { value: new THREE.Vector3(AMBIENT, AMBIENT, AMBIENT) },
    kSunDir: { value: new THREE.Vector3().fromArray(FALLBACK_DIR).normalize() },
  };
  return LIGHT;
}

export function setLighting(opts) {
  const L = ensureLight();
  if (opts.lightDir && !HOST_DIR) HOST_DIR = [opts.lightDir[0], opts.lightDir[1], opts.lightDir[2]];
  if (CTL) return applyControl();
  if (opts.lightDir) L.kSunDir.value.fromArray(opts.lightDir).normalize();
  if (opts.sun) L.kSun.value.fromArray(opts.sun);
  if (opts.specular) L.kSunSpec.value.fromArray(opts.specular);
  if (opts.ambient) L.kAmbient.value.fromArray(opts.ambient);
}

// intensity 0..1 moves the sun's share into ambient; azimuth/elevation in degrees; null resets.
export function setLightControl(ctl) {
  CTL = ctl ? { intensity: ctl.intensity, azimuth: ctl.azimuth, elevation: ctl.elevation } : null;
  if (CTL) return applyControl();
  const L = ensureLight();
  L.kSun.value.setScalar(SUN);
  L.kSunSpec.value.setScalar(SUN_SPEC);
  L.kAmbient.value.setScalar(AMBIENT);
  L.kSunDir.value.fromArray(HOST_DIR || FALLBACK_DIR).normalize();
}

function applyControl() {
  const L = ensureLight(), t = Math.max(0, Math.min(1, CTL.intensity));
  L.kSun.value.setScalar(SUN * t);
  L.kSunSpec.value.setScalar(SUN_SPEC * t);
  L.kAmbient.value.setScalar(AMBIENT + SUN * (1 - t));
  const e = CTL.elevation * Math.PI / 180, a = CTL.azimuth * Math.PI / 180;
  L.kSunDir.value.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
}

export const sunDirection = () => ensureLight().kSunDir.value.toArray();

export function lightControlDefaults() {
  const d = HOST_DIR || FALLBACK_DIR, DEG = 180 / Math.PI;
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return {
    intensity: 1,
    azimuth: (Math.round(Math.atan2(d[0], d[2]) * DEG) + 360) % 360,
    elevation: Math.round(Math.asin(d[1] / len) * DEG),
  };
}

const VERT = `attribute vec3 color;
varying vec3 vCol;
varying vec3 vNor;
varying vec3 vEye;
void main() {
  vCol = color;
  vNor = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vEye = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

// terrain.fragment's CalcTerrainColor with no world inputs: wrap diffuse, baked BRDF lobe, ambient.
const FRAG = `uniform sampler2D kBrdfMap;
uniform vec3 kSun;
uniform vec3 kSunSpec;
uniform vec3 kAmbient;
uniform vec3 kSunDir;
uniform float kTile;
uniform float kGlow;
uniform float kOpacity;
varying vec3 vCol;
varying vec3 vNor;
varying vec3 vEye;

vec3 kBrdf(vec3 N, vec3 L, vec3 E) {
  float sel = floor(kTile + 0.01);
  float bias = kTile - sel;
  vec2 cell = vec2(mod(sel, 4.0), step((kTile + 0.01) / 4.0, 1.0));
  vec3 H = normalize(E + L);
  vec2 tx;
  tx.x = clamp((dot(N, H) / (1.0 - bias)) - bias / (1.0 - bias), 0.0078125, 0.9921875);
  tx.y = clamp(dot(L, H), 0.00390625, 0.99609375);
  return texture2D(kBrdfMap, (cell + tx) * vec2(0.25, 0.5)).rgb
         * clamp(dot(N, L) * 2.0 + 1.0, 0.0, 1.0) * 1.5;
}

void main() {
  vec3 N = normalize(vNor);
  vec3 E = normalize(vEye);
  vec3 L = normalize((viewMatrix * vec4(kSunDir, 0.0)).xyz);
  vec3 spec = kBrdf(N, L, E) * kSunSpec;
  vec3 lighting = kSun * pow(max(dot(N, L) * 0.7 + 0.3, 0.0), 0.65) + spec + kAmbient;
  vec3 lit = vCol * mix(lighting, vec3(1.2), kGlow);
  gl_FragColor = vec4(lit, max(max(spec.r, spec.g), max(kOpacity, spec.b)));
}`;

// The specular atlas, once per page; without it highlights read black and nothing else breaks.
function loadBrdf(url, onReady) {
  if (BRDF_MAP.value) return;
  if (onReady) brdfWaiters.push(onReady);
  if (brdfLoad) return;
  brdfLoad = true;
  new THREE.TextureLoader().load(url, (tex) => {
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    BRDF_MAP.value = tex;
    brdfWaiters.splice(0).forEach((fn) => fn());
  }, undefined, () => { brdfWaiters.length = 0; });
}

// 0 solid, 1 glass, 2 glow, 3 glow-glass; glass opacity = (level/255)^2.
export function makeMaterial(kind, level, spec) {
  const L = ensureLight(), glass = kind === 1 || kind === 3;
  return new THREE.ShaderMaterial({
    uniforms: {
      kBrdfMap: L.kBrdfMap, kSun: L.kSun, kSunSpec: L.kSunSpec, kAmbient: L.kAmbient, kSunDir: L.kSunDir,
      kTile: { value: kind === 0 ? (spec || 0) : 0 },
      kGlow: { value: (kind === 2 || kind === 3) ? 1 : 0 },
      kOpacity: { value: glass ? Math.pow((level || 255) / 255, 2) : 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: glass,
    depthWrite: !glass,
  });
}

function occupancy(X, Y, Z, n) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
    if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
  }
  const w = maxX - minX + 3, h = maxY - minY + 3, d = maxZ - minZ + 3;
  if (n && w * h * d <= MAX_CELLS) {
    const grid = new Int32Array(w * h * d), hd = h * d;
    for (let i = 0; i < n; i++) grid[(X[i] - minX + 1) * hd + (Y[i] - minY + 1) * d + (Z[i] - minZ + 1)] = i + 1;
    return (x, y, z) => {
      x -= minX; y -= minY; z -= minZ;
      if (x < -1 || y < -1 || z < -1 || x > w - 2 || y > h - 2 || z > d - 2) return 0;
      return grid[(x + 1) * hd + (y + 1) * d + (z + 1)];
    };
  }
  const map = new Map();
  for (let i = 0; i < n; i++) map.set(X[i] + ',' + Y[i] + ',' + Z[i], i + 1);
  return (x, y, z) => map.get(x + ',' + y + ',' + z) || 0;
}

// part: {x, y, z, rgb, kind, level, spec}; opts: {brdfUrl, lightDir, sun, ambient, specular, onReady}.
export function build(part, opts = {}) {
  const X = part.x, Y = part.y, Z = part.z, RGB = part.rgb, KIND = part.kind, LVL = part.level, SPEC = part.spec;
  const n = X ? X.length : 0;
  if (!n) return [];
  setLighting(opts);
  if (opts.brdfUrl) loadBrdf(opts.brdfUrl, opts.onReady);

  const at = occupancy(X, Y, Z, n);
  const kindOf = (i) => (KIND ? (KIND[i] || 0) : 0);
  const groupOf = (i, k) => k + ':' + ((k === 1 || k === 3) ? (LVL ? LVL[i] : 255) : 255) + ':' + (k === 0 && SPEC ? (SPEC[i] || 0) : 0);

  // opaque faces hide behind opaque neighbours; glass faces hide behind any neighbour
  const mask = new Uint8Array(n), counts = {};
  for (let i = 0; i < n; i++) {
    const k = kindOf(i), opaque = isOpaque(k);
    let bits = 0, drawn = 0;
    for (let f = 0; f < 6; f++) {
      const F = FACES[f], nb = at(X[i] + F[0], Y[i] + F[1], Z[i] + F[2]);
      if (nb === 0 || (opaque && !isOpaque(kindOf(nb - 1)))) { bits |= 1 << f; drawn++; }
    }
    mask[i] = bits;
    if (drawn) { const g = groupOf(i, k); counts[g] = (counts[g] || 0) + drawn; }
  }

  const buffers = {};
  for (const g of Object.keys(counts)) {
    const q = counts[g];
    buffers[g] = { pos: new Float32Array(q * 12), nor: new Float32Array(q * 12), col: new Float32Array(q * 12), idx: new Uint32Array(q * 6), v: 0, t: 0 };
  }

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const b = buffers[groupOf(i, kindOf(i))];
    const c = RGB ? RGB[i] : 0xffffff;
    const cr = ((c >> 16) & 255) / 255, cg = ((c >> 8) & 255) / 255, cb = (c & 255) / 255;
    const x = X[i], y = Y[i], z = Z[i];
    for (let f = 0; f < 6; f++) {
      if (!(mask[i] & (1 << f))) continue;
      const F = FACES[f];
      const fx = x + F[0] * 0.5, fy = y + F[1] * 0.5, fz = z + F[2] * 0.5;
      const ux = F[3] * 0.5, uy = F[4] * 0.5, uz = F[5] * 0.5;
      const vx = F[6] * 0.5, vy = F[7] * 0.5, vz = F[8] * 0.5;
      const base = b.v / 3, p = b.v;
      b.pos[p] = fx - ux - vx; b.pos[p + 1] = fy - uy - vy; b.pos[p + 2] = fz - uz - vz;
      b.pos[p + 3] = fx + ux - vx; b.pos[p + 4] = fy + uy - vy; b.pos[p + 5] = fz + uz - vz;
      b.pos[p + 6] = fx + ux + vx; b.pos[p + 7] = fy + uy + vy; b.pos[p + 8] = fz + uz + vz;
      b.pos[p + 9] = fx - ux + vx; b.pos[p + 10] = fy - uy + vy; b.pos[p + 11] = fz - uz + vz;
      for (let j = 0; j < 4; j++) {
        b.nor[p + j * 3] = F[0]; b.nor[p + j * 3 + 1] = F[1]; b.nor[p + j * 3 + 2] = F[2];
        b.col[p + j * 3] = cr; b.col[p + j * 3 + 1] = cg; b.col[p + j * 3 + 2] = cb;
      }
      b.v += 12;
      b.idx[b.t] = base; b.idx[b.t + 1] = base + 1; b.idx[b.t + 2] = base + 2;
      b.idx[b.t + 3] = base; b.idx[b.t + 4] = base + 2; b.idx[b.t + 5] = base + 3;
      b.t += 6;
    }
  }

  return Object.keys(buffers).map((g) => {
    const b = buffers[g], [k, lv, sp] = g.split(':').map(Number);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(b.col, 3));
    geo.setIndex(new THREE.BufferAttribute(b.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, makeMaterial(k, lv, sp));
    if (k === 1 || k === 3) mesh.renderOrder = 1;
    return mesh;
  });
}
