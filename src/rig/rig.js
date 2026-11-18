// A baked rig and the assembly of blueprint parts onto its attach points.
import { decodeCells } from '../formats/blueprint.js';
import { fma, pairwise, roundHalfEven } from './exact.js';

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class Rig {
  constructor(raw) {
    this.raw = raw;
    this.voxelScale = typeof raw.voxel_scale === 'number' ? raw.voxel_scale : 0;
    this.rest = raw.rest && typeof raw.rest === 'object' ? raw.rest : {};
    this.headAps = headApsOf(raw);
  }
  hasAp(ap) { return Object.prototype.hasOwnProperty.call(this.rest, ap); }
  isHeadAp(ap) { return this.headAps.has(ap); }
  animationNames() { return Object.keys(this.raw.animations || {}); }
}

// Attach points (AP_* bones) that sit under head_JNT.
function headApsOf(raw) {
  const b = raw.bones || {};
  const names = (b.names || []).map((n) => String(n ?? ''));
  const parents = b.parents || [];
  const heads = new Set();
  names.forEach((n, i) => { if (n.toLowerCase() === 'head_jnt') heads.add(i); });
  const out = new Set();
  names.forEach((name, i) => {
    if (!name.toLowerCase().startsWith('ap_')) return;
    let j = Number.isInteger(parents[i]) ? parents[i] : null, guard = 0;
    while (j !== null) {
      if (j < 0 || j >= names.length || guard > names.length) break;
      if (heads.has(j)) { out.add([...name].slice(3).join('').toLowerCase()); break; }
      j = Number.isInteger(parents[j]) ? parents[j] : null;
      guard++;
    }
  });
  return out;
}

export function scaleFor(ap, rig, headScale, partScale) {
  return partScale * (rig && rig.isHeadAp(ap) ? headScale : 1);
}

// One part's voxels in its own frame, or null when the blueprint holds none.
export function partAt(key, raw, scale) {
  const cells = decodeCells(raw);
  if (!cells) return null;
  const spec = cells.map((c) => c.spec);
  return {
    name: key,
    x: cells.map((c) => c.x), y: cells.map((c) => c.y), z: cells.map((c) => c.z),
    rgb: cells.map((c) => ((c.r << 16) | (c.g << 8) | c.b) >>> 0),
    kind: cells.map((c) => c.kind), level: cells.map((c) => c.level),
    spec: spec.some((s) => s !== 0) ? spec : null,
    scale: scale !== 1 ? scale : null,
    shifted: false,
  };
}

const partScale = (p) => p.scale ?? 1;
const scaleKey = (s) => (s === 0 ? 0 : s);

// Parts on the same attach point at the same scale become one.
export function mergeSameAp(parts) {
  const out = [];
  for (const part of parts) {
    const into = out.find((p) => p.name === part.name && scaleKey(partScale(p)) === scaleKey(partScale(part)));
    if (!into) { out.push(part); continue; }
    const nInto = into.x.length, nPart = part.x.length;
    for (const k of ['x', 'y', 'z', 'rgb', 'kind', 'level']) into[k] = into[k].concat(part[k]);
    if (into.spec || part.spec) into.spec = (into.spec || new Array(nInto).fill(0)).concat(part.spec || new Array(nPart).fill(0));
  }
  return out;
}

// Column-major rest matrix times diag(ps, ps, ps, 1), as rows.
function placed(rest, ps) {
  const m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[r][c] = rest[c * 4 + r] * (c < 3 ? ps : 1);
  return m;
}

function world(m, x, y, z, single) {
  const row = (r) => single
    ? (m[r][0] * x + m[r][2] * z) + (m[r][1] * y + m[r][3])
    : fma(m[r][2], z, fma(m[r][1], y, m[r][0] * x)) + m[r][3];
  return [row(0), row(1), row(2)];
}

function worldsOf(m, p) {
  const single = p.x.length === 1, out = new Array(p.x.length);
  for (let i = 0; i < p.x.length; i++) out[i] = world(m, p.x[i], p.y[i], p.z[i], single);
  return out;
}

function meanCols(points) {
  const n = points.length, col = new Float64Array(n), out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < n; i++) col[i] = points[i][k];
    out[k] = (0 + pairwise(col)) / n;
  }
  return out;
}

// LAPACK getf2 LU then the triangular solves against the identity, as numpy inverts.
function inv3(a) {
  const col = [0, 1, 2].map((j) => [0, 1, 2].map((i) => a[i][j]));
  const ipiv = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < j; i++) { const p = ipiv[i]; [col[j][i], col[j][p]] = [col[j][p], col[j][i]]; }
    for (let i = 1; i < j; i++) {
      let d = 0;
      for (let k = 0; k < i; k++) d = d + col[k][i] * col[j][k];
      col[j][i] -= d;
    }
    for (let i = j; i < 3; i++) {
      let acc = 0;
      for (let k = 0; k < j; k++) acc = acc + col[k][i] * col[j][k];
      col[j][i] -= acc;
    }
    let jp = j;
    for (let i = j + 1; i < 3; i++) if (Math.abs(col[j][i]) > Math.abs(col[j][jp])) jp = i;
    ipiv[j] = jp;
    if (jp !== j) for (let c = 0; c <= j; c++) [col[c][j], col[c][jp]] = [col[c][jp], col[c][j]];
    if (col[j][j] === 0) return null;
    const r = 1 / col[j][j];
    for (let i = j + 1; i < 3; i++) col[j][i] *= r;
  }
  const lu = (i, k) => col[k][i];
  const inv = [0, 1, 2].map((i) => 1 / lu(i, i));
  const x = [];
  for (let c = 0; c < 3; c++) {
    const b = [0, 1, 2].map((i) => (i === c ? 1 : 0));
    for (let i = 0; i < 3; i++) { const p = ipiv[i]; [b[i], b[p]] = [b[p], b[i]]; }
    b[1] -= b[0] * lu(1, 0);
    b[2] -= fma(lu(2, 1), b[1], lu(2, 0) * b[0]);
    const x2 = b[2] * inv[2];
    b[0] -= lu(0, 2) * x2;
    b[1] -= lu(1, 2) * x2;
    const x1 = b[1] * inv[1];
    b[0] -= x1 * lu(0, 1);
    x.push([b[0] * inv[0], x1, x2]);
  }
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => x[c][r]));
}

// Nudge a mostly-glowing part that is fully enclosed by others 1.5 voxels outward.
export function unbury(parts, rig) {
  const vs = rig.voxelScale, cell = vs === 0 ? 1 : vs, tol = cell * 0.6;
  const grid = new Map(), worlds = [], mats = [];
  const key = (q) => roundHalfEven(q[0] / cell) + ',' + roundHalfEven(q[1] / cell) + ',' + roundHalfEven(q[2] / cell);
  for (const p of parts) {
    const m = placed(rig.rest[p.name] || IDENT, vs * partScale(p));
    const w = worldsOf(m, p);
    for (const pt of w) {
      const k = key(pt);
      const list = grid.get(k);
      if (list) list.push(pt); else grid.set(k, [pt]);
    }
    mats.push(m); worlds.push(w);
  }
  const all = worlds.flat();
  if (!all.length) return;
  const centre = meanCols(all);
  const occupied = (q) => {
    const b = [roundHalfEven(q[0] / cell), roundHalfEven(q[1] / cell), roundHalfEven(q[2] / cell)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const pts = grid.get((b[0] + dx) + ',' + (b[1] + dy) + ',' + (b[2] + dz));
      if (pts && pts.some((pt) => Math.abs(pt[0] - q[0]) < tol && Math.abs(pt[1] - q[1]) < tol && Math.abs(pt[2] - q[2]) < tol)) return true;
    }
    return false;
  };
  const axes = [[cell, 0, 0], [-cell, 0, 0], [0, cell, 0], [0, -cell, 0], [0, 0, cell], [0, 0, -cell]];
  parts.forEach((p, idx) => {
    if (!p.kind.length) return;
    const glow = p.kind.filter((k) => k === 2 || k === 3).length;
    if (glow / p.kind.length < 0.5) return;
    const w = worlds[idx];
    if (!w.every((pt) => axes.every((ax) => occupied([pt[0] + ax[0], pt[1] + ax[1], pt[2] + ax[2]])))) return;
    const pm = meanCols(w);
    const out = [pm[0] - centre[0], pm[1] - centre[1], pm[2] - centre[2]];
    const norm = Math.sqrt(0 + out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
    if (norm < 1e-9) return;
    const m = mats[idx];
    const inv = inv3([[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]]);
    if (!inv) throw new Error('LinAlgError: Singular matrix');
    const k = 1.5 * vs;
    const v = [out[0] / norm * k, out[1] / norm * k, out[2] / norm * k];
    const d = [0, 1, 2].map((r) => fma(inv[r][2], v[2], fma(inv[r][0], v[0], inv[r][1] * v[1])));
    p.x = p.x.map((x) => x + d[0]);
    p.y = p.y.map((y) => y + d[1]);
    p.z = p.z.map((z) => z + d[2]);
    p.shifted = true;
  });
}

export const basenameOf = (path) => {
  const name = [...path.replace(/\\/g, '/').split('/').pop()];
  return name.slice(0, Math.max(0, name.length - 10)).join('').toLowerCase();
};

// files: [[path, bytes]]; overrides/partScales keyed by the dropped basename.
export function assembleParts(rig, files, overrides, partScales) {
  let parts = [];
  for (const [path, raw] of files) {
    const p = path.toLowerCase();
    const last = p.split('/').pop();
    if (!last.endsWith('.blueprint')) continue;
    const stem = last.slice(0, -10);
    const key = overrides.get(stem);
    if (!key || !rig.hasAp(key)) continue;
    const scale = partScales.has(stem) ? partScales.get(stem) : scaleFor(key, rig, 1, 1);
    let part;
    try { part = partAt(key, raw, scale); } catch (e) { throw new Error(`${path.split('/').pop()}: ${e.message}`, { cause: e }); }
    if (part) parts.push(part);
  }
  if (!parts.length) return parts;
  parts = mergeSameAp(parts);
  unbury(parts, rig);
  return parts;
}

export function payload(rig, rigName, parts) {
  return { voxel_scale: rig.raw.voxel_scale ?? null, rig: rigName, parts, rest: rig.raw.rest ?? null, animations: rig.raw.animations ?? null };
}
